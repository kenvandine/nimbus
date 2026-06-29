from __future__ import annotations

import re
import subprocess
from functools import lru_cache
from pathlib import Path


CHASSIS_TYPES: dict[str, str] = {
    "1": "Other", "2": "Unknown", "3": "Desktop", "4": "Low Profile Desktop",
    "5": "Pizza Box", "6": "Mini Tower", "7": "Tower", "8": "Portable",
    "9": "Laptop", "10": "Notebook", "11": "Hand Held", "12": "Docking Station",
    "13": "All in One", "14": "Sub Notebook", "15": "Space-saving",
    "17": "Server", "23": "Rack Mount", "30": "Tablet", "31": "Convertible",
    "32": "Detachable", "35": "Mini PC", "36": "Stick PC",
}


def _dmi(field: str) -> str | None:
    try:
        val = Path(f"/sys/class/dmi/id/{field}").read_text().strip()
        return val or None
    except OSError:
        return None


def _cpu_model() -> str | None:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return None


def _cpu_cores() -> tuple[int | None, int | None]:
    """Return (physical_cores, logical_cores)."""
    physical = logical = None
    try:
        import psutil
        physical = psutil.cpu_count(logical=False)
        logical = psutil.cpu_count(logical=True)
        return physical, logical
    except Exception:
        pass
    try:
        text = Path("/proc/cpuinfo").read_text()
        physical = next(
            (int(l.split(":", 1)[1]) for l in text.splitlines() if l.startswith("cpu cores")),
            None,
        )
        logical = sum(1 for l in text.splitlines() if l.startswith("processor")) or None
    except OSError:
        pass
    return physical, logical


def _ram_total_mb() -> int | None:
    try:
        import psutil
        return psutil.virtual_memory().total // (1024 * 1024)
    except Exception:
        pass
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) // 1024
    except OSError:
        pass
    return None


def _round_ram_gb(ram_mb: int) -> int:
    """Round OS-reported RAM up to the nearest standard DIMM capacity.

    Integrated GPUs and firmware reservations reduce OS-visible RAM below the
    marketed spec (e.g. 64 GB RAM → ~55.8 GB visible).  Rounding to the
    nearest power-of-two boundary (or common multi-channel sizes) recovers the
    expected marketing value.
    """
    gb = ram_mb / 1024
    standard = [2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512]
    for s in standard:
        if gb <= s * 1.05:
            return s
    return round(gb)


def _gpu_name() -> str | None:
    try:
        result = subprocess.run(
            ["lspci"], capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0:
            for line in result.stdout.splitlines():
                if re.search(r"\b(VGA compatible controller|3D controller|Display controller)\b", line, re.IGNORECASE):
                    parts = line.split(":", 2)
                    if len(parts) >= 3:
                        return parts[2].strip()
    except Exception:
        pass

    # Integrated GPU embedded in CPU model name (e.g. "AMD Ryzen … w/ Radeon 860M")
    cpu = _cpu_model()
    if cpu:
        m = re.search(r"\bw/\s+(.+)$", cpu, re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


@lru_cache(maxsize=1)
def get_hardware_info() -> dict:
    physical_cores, logical_cores = _cpu_cores()
    ram_mb = _ram_total_mb()
    ram_gb = _round_ram_gb(ram_mb) if ram_mb else None

    vendor = _dmi("sys_vendor")
    product = _dmi("product_name")
    version = _dmi("product_version")
    chassis_type_raw = _dmi("chassis_type")
    chassis_type = CHASSIS_TYPES.get(chassis_type_raw or "", None)

    system_name: str | None = None
    if vendor and product:
        system_name = f"{vendor} {product}"
        if version and version.lower() not in ("", "none", "not applicable"):
            system_name = f"{vendor} {version}"

    return {
        "cpu_model": _cpu_model(),
        "cpu_cores_physical": physical_cores,
        "cpu_cores_logical": logical_cores,
        "ram_gb": ram_gb,
        "gpu": _gpu_name(),
        "sys_vendor": vendor,
        "product_name": product,
        "product_version": version,
        "system_name": system_name,
        "chassis_type": chassis_type,
    }


def best_disk_path() -> str:
    """Return the most relevant disk path to measure on this host.

    Ubuntu Core mounts snaps from read-only loop devices at /, with real
    user data on /writable (or /ubuntu-data on older images).  Measuring /
    on Ubuntu Core returns the tiny squashfs size, not the actual disk.

    We avoid psutil.disk_partitions() because it is unreliable inside snap
    confinement.  Instead, we just statvfs a set of candidates and pick
    whichever has the largest total capacity — that's always the real disk.
    """
    import psutil
    candidates = ["/writable", "/ubuntu-data", "/data", "/var/snap", "/"]
    best_path = "/"
    best_total = 0
    for path in candidates:
        try:
            usage = psutil.disk_usage(path)
            if usage.total > best_total:
                best_total = usage.total
                best_path = path
        except OSError:
            pass
    return best_path
