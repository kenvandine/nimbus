# Nimbus Appliance Installer

Build an unattended Ubuntu Server installer ISO that writes a pre-built
appliance disk image (`pc.img.xz`) to the target machine's internal drive
on first boot, then powers off.

The resulting ISO is meant to be burned to a USB stick. When the appliance
hardware boots from the stick, it auto-detects the single internal disk,
decompresses `pc.img.xz` and streams it into `dd`, and powers down — no
operator interaction required.

## Contents

| File | Purpose |
| --- | --- |
| `install.sh` | Runs on the booted ISO. Finds the single non-USB disk and streams `pc.img.xz` through `xzcat` into `dd`. |
| `build-iso.sh` | Wraps [`livefs-edit`](https://github.com/mwhudson/livefs-editor) to inject `install.sh`, `pc.img.xz`, and a systemd unit into an Ubuntu Server ISO, and to mask subiquity. |
| `requirements.txt` | Python dependencies (livefs-edit, PyYAML, python-debian). |

## Prerequisites

- A Debian/Ubuntu host to run `build-iso.sh` on. Other distros work if you
  install the system packages yourself.
- Root access on the build host (livefs-edit modifies a loop-mounted ISO
  and unpacks squashfs layers).
- An Ubuntu 26.04 server ISO (the live-server flavor, not the desktop
  installer).
- A built appliance disk image, xz-compressed (`pc.img.xz`) — a raw image
  of the OS you want flashed onto each appliance, compressed with
  `xz -T0 pc.img` (or similar).

`build-iso.sh` will `apt-get install` anything missing from this list:

- `xorriso`
- `squashfs-tools` (provides `mksquashfs` / `unsquashfs`)
- `python3`
- `python3-venv`

Python packages are installed into a local venv at `installer/.venv/`.

## Building an ISO

```sh
sudo ./build-iso.sh <input-iso> <output-iso> <pc-img-xz>
```

Example:

```sh
sudo ./build-iso.sh \
    ~/Downloads/ubuntu-26.04-live-server-amd64.iso \
    ./nimbus-appliance.iso \
    ./pc.img.xz
```

What the script does, in order:

1. Validates inputs and that it's running as root.
2. Installs any missing system packages via `apt-get`.
3. Creates or refreshes `installer/.venv/` from `requirements.txt`. The
   venv is refreshed whenever `requirements.txt` is newer than the
   installed `livefs-edit` binary.
4. Loop-mounts the input ISO read-only to enumerate the squashfs layers
   under `/casper/`. Computes a "keep" set from
   `NIMBUS_LAYERFS_PATH` (default: `ubuntu-server-minimal.ubuntu-server`)
   by splitting on `.` — every dot-prefix is kept, everything else is
   dropped. Picks the shortest kept layer as the injection target
   (override with `NIMBUS_SQUASHFS=<name>`).
5. Writes a `nimbus-install.service` systemd unit to a temp dir.
6. Invokes `livefs-edit` to:
   - Copy `install.sh` to the ISO root (visible as `/cdrom/install.sh`
     on the booted system).
   - Copy `pc.img.xz` to the ISO root (`/cdrom/pc.img.xz`).
   - `--edit-squashfs` the chosen layer (mounts an overlay), then writes
     `/etc/systemd/system/nimbus-install.service` into it and creates the
     `multi-user.target.wants/` symlink to enable it.
   - Delete the dropped squashfses and their `.manifest{,.full}` /
     `.size` sidecar files, plus `/pool` (subiquity's offline package
     archive, ~1.2 GB), `/dists` (apt metadata for it), and
     `/md5sum.txt`. None of these are touched in our use case.
   - Add `layerfs-path=...` to the kernel command line so casper only
     mounts the kept chain.
   - Add `cloud-init=disabled` so cloud-init exits immediately (it
     otherwise waits on cloud metadata that will never arrive on bare
     metal).
   - Add `systemd.mask=` for `snap.subiquity.subiquity-server.service`
     and `snap.subiquity.subiquity-service.service` as defense in
     depth, in case the installer layer ever gets reintroduced.
7. Repacks the modified squashfs and writes the output ISO.

## What happens at boot

1. The casper live boot loads the modified squashfs.
2. systemd refuses to start the masked subiquity units, so the interactive
   installer never appears.
3. `multi-user.target` pulls in `nimbus-install.service`, which runs
   `/cdrom/install.sh` on `tty1` with stdin/stdout/stderr attached so
   the TUI is interactive.

`install.sh` drives a whiptail-based TUI:

1. A welcome dialog explains what the installer will do.
2. Detects block devices via `lsblk -d -n -o NAME,TYPE,TRAN`, filtering
   for `TYPE=disk` and `TRAN!=usb` (so loop, ROM, and the USB boot
   stick are skipped). If zero or more than one disk matches, shows the
   error in a dialog and offers reboot/poweroff.
3. Displays the target device, its size, and model, then prompts for
   confirmation (default = No).
4. On confirm, streams `xzcat pc.img.xz | dd of=<disk> bs=4M
   conv=fsync` and feeds a `whiptail --gauge` from
   `/proc/<dd-pid>/io` for live progress.
5. Verifies the final byte count against the xz file's uncompressed
   size (so a truncated decompression is caught even if `dd` returned
   0).
6. Shows success or failure, then prompts the operator to reboot or
   power off; the script `exec`s into `/sbin/reboot` or `/sbin/poweroff`
   accordingly.

`install.sh` resolves `pc.img.xz` relative to its own directory, so the
same script works whether it's invoked from `/cdrom/install.sh` at boot
or from a working copy alongside a local image.

## Customizing

- **Default action after install**: the TUI prompts for reboot or power
  off at the end, so there's nothing to edit in the unit. If you want a
  non-interactive run (e.g. for factory provisioning), replace the
  `post_action_menu` calls in `install.sh` with a hard-coded
  `exec /sbin/poweroff` (or `reboot`).
- **Installer colors**: `install.sh` now sets a dark `whiptail` /
  `newt` palette by default so the TUI looks closer to Ubuntu's console
  styling, including the gauge colors used by the progress bar. To
  override it, set `NEWT_COLORS` before running the script or replace
  the default palette block near the top of `install.sh`.
- **Which layers to keep**: set
  `NIMBUS_LAYERFS_PATH=<top-layer-name>` to keep a different chain.
  Defaults to `ubuntu-server-minimal.ubuntu-server`. The script will
  fail fast if any layer in the chain isn't in the source ISO.
- **Which squashfs layer the unit lands in**: by default the script
  picks the shortest-named layer in the kept chain (the base squashfs).
  Casper stacks the chain at boot, so files in the base are visible
  regardless. Override with `NIMBUS_SQUASHFS=<layer-name>` (must be one
  of the kept layers). Note: targeting an installer-specific overlay
  may fail because thin overlays often lack `/etc/resolv.conf`, which
  `livefs-edit`'s `edit-squashfs` action needs in order to set up
  chroot mounts.
- **Which subiquity units to mask**: edit the `--add-cmdline-arg
  "systemd.mask=..."` lines. Subiquity service names occasionally shift
  between Ubuntu releases.
- **Keeping subiquity**: if you actually want subiquity available
  (e.g. as a fallback), set
  `NIMBUS_LAYERFS_PATH=ubuntu-server-minimal.ubuntu-server.installer.generic`
  to keep all four layers. You'll then want to drop the
  `cloud-init=disabled` arg and the subiquity masks too.

## Testing the resulting ISO

Before pointing it at real hardware, boot the ISO under QEMU **with
UEFI firmware**. Real modern hardware boots UEFI, and Ubuntu's grub
config in the ISO only sets up the EFI boot path, so SeaBIOS gives
"no bootable device".

```sh
sudo apt install ovmf  # provides OVMF_CODE_4M.fd / OVMF_VARS_4M.fd
qemu-img create -f raw blank-target.img 20G
cp /usr/share/OVMF/OVMF_VARS_4M.fd ovmf-vars.fd

qemu-system-x86_64 \
    -enable-kvm -m 4G -machine q35 \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,file=ovmf-vars.fd \
    -drive file=nimbus-appliance.iso,format=raw,media=cdrom \
    -drive file=blank-target.img,format=raw \
    -boot d
```

The VM should boot through the grub menu ("Install Your AI
Appliance"), drop straight into the whiptail TUI, write the
decompressed `pc.img.xz` to the virtual disk, and on success offer
reboot or poweroff. After install you can boot the written disk on
its own:

```sh
qemu-system-x86_64 \
    -enable-kvm -m 4G -machine q35 \
    -drive if=pflash,format=raw,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.fd \
    -drive if=pflash,format=raw,file=ovmf-vars.fd \
    -drive file=blank-target.img,format=raw \
    -boot c
```

If your distro keeps OVMF in a different location, adjust the
`OVMF_CODE_4M.fd` / `OVMF_VARS_4M.fd` paths. Some older distros use
`OVMF_CODE.fd` / `OVMF_VARS.fd` (without the `_4M` suffix).

## Known limitations

- **Disk selection heuristic is `TYPE=disk`, `TRAN != usb`, and name
  not matching `fd[0-9]`**. NVMe, SATA, and SAS all pass; eMMC and
  Thunderbolt-attached drives also pass and would be targets. If your
  fleet has more exotic transports, tighten the awk filter in
  `install.sh`.
- **No checksum verification**. If you need to be sure the image wrote
  correctly, follow the `dd` with a `cmp` or `sha256sum` pass before the
  reboot/poweroff menu.
- **whiptail dependency**. The TUI assumes `whiptail` (from the
  `whiptail` / `libnewt0.52` packages) is in the booted live filesystem.
  It is, on Ubuntu Server 26.04 — present from the
  `ubuntu-server-minimal.ubuntu-server` layer up.
- **The build venv is owned by root** since `build-iso.sh` runs as root.
  `sudo rm -rf .venv` to clean it up.
