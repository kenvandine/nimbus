set -eu

NIMBUS_SNAP=$(ls ../nimbus*.snap | head -n1)
SNAP_GNUPG_HOME=${SNAP_GNUPG_HOME:-"$HOME/.snap/gnupg"}
ROOT_GNUPG_HOME=$(mktemp -d)

cleanup() {
    rm -rf "$ROOT_GNUPG_HOME"
}

trap cleanup EXIT

# ubuntu-image runs with sudo for image creation, so preseed signing also runs
# as root. GnuPG refuses to use the user-owned snap keyring in that case, so
# provide a root-owned copy just for this invocation.
cp -a "$SNAP_GNUPG_HOME"/. "$ROOT_GNUPG_HOME"/
find "$ROOT_GNUPG_HOME" \( -type s -o -name '*.lock' \) -delete
sudo chown -R root:root "$ROOT_GNUPG_HOME"

snap sign -k my-key nimbus-model.json > nimbus-model.model

# ubuntu-image only accepts extra assertions such as system-user here.
# snap-declaration and snap-revision assertions are rejected, so a local snap
# passed via --snap will still seed as x1. Use a Store-published revision if
# you need an asserted snap revision in the image.
sudo env -u SUDO_UID -u SUDO_GID -u SUDO_USER \
    SNAP_GNUPG_HOME="$ROOT_GNUPG_HOME" \
    ubuntu-image snap nimbus-model.model \
    --snap ../../pc-amd64-gadget/pc_24-0.2_amd64.snap \
    --image-size=10G \
    --preseed --preseed-sign-key my-key

cp pc.img appliance.img
sudo chown "$(id -un):$(id -gn)" pc.img appliance.img
# Optimize for the smallest .xz output; this is slower than the default preset.
#xz -v -9e -T1 pc.img
xz -v -7 -T0 pc.img
