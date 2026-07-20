#!/usr/bin/env python3
"""
Extract SQLCipher key from Trae Work (TRAE SOLO CN / Trae CN) process memory.

Requirements:
  - Windows with admin privileges
  - Trae Work must be running (ai_agent.dll loaded)
  - Python 3.10+

Usage:
  python scripts/extract-trae-key.py [--output PATH]

The extracted key is saved as JSON compatible with Token Monitor's
trae-key.json format: { "key": "<64-char-hex>" }

Default output locations (first writable wins):
  1. Next to the database file
  2. Token Monitor shared data dir (%APPDATA%/Token Monitor/trae-key.json)
"""

import argparse
import ctypes
import ctypes.wintypes as wt
import hashlib
import json
import os
import re
import struct
import subprocess
import sys
import time

# ─── Windows API ───────────────────────────────────────────────────────────────

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
READABLE_PAGES = 0x02 | 0x04 | 0x08 | 0x20 | 0x40 | 0x80


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)

kernel32.OpenProcess.restype = wt.HANDLE
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.VirtualQueryEx.restype = ctypes.c_size_t
kernel32.VirtualQueryEx.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.POINTER(MEMORY_BASIC_INFORMATION), ctypes.c_size_t]
kernel32.ReadProcessMemory.restype = wt.BOOL
kernel32.ReadProcessMemory.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
kernel32.CloseHandle.restype = wt.BOOL
kernel32.CloseHandle.argtypes = [wt.HANDLE]

psapi.EnumProcessModulesEx.restype = wt.BOOL
psapi.EnumProcessModulesEx.argtypes = [wt.HANDLE, ctypes.POINTER(ctypes.c_void_p), wt.DWORD, ctypes.POINTER(wt.DWORD), wt.DWORD]
psapi.GetModuleFileNameExW.restype = wt.DWORD
psapi.GetModuleFileNameExW.argtypes = [wt.HANDLE, ctypes.c_void_p, ctypes.c_wchar_p, wt.DWORD]


# ─── Database path ─────────────────────────────────────────────────────────────

def find_database():
    appdata = os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming"))
    candidates = [
        os.path.join(appdata, "TRAE SOLO CN", "ModularData", "ai-agent", "database.db"),
        os.path.join(appdata, "Trae CN", "ModularData", "ai-agent", "database.db"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return None


# ─── Process discovery ─────────────────────────────────────────────────────────

def find_ai_agent_pid():
    """Find PID of the process that has ai_agent.dll loaded."""
    result = subprocess.run(
        ["tasklist", "/FO", "CSV", "/NH"],
        capture_output=True, text=True, encoding="gbk", errors="ignore"
    )
    for line in result.stdout.strip().split("\n"):
        parts = line.replace('"', "").split(",")
        if len(parts) < 2:
            continue
        proc_name = parts[0].lower()
        if "trae" not in proc_name:
            continue
        try:
            pid = int(parts[1])
        except ValueError:
            continue
        if _has_module(pid, "ai_agent"):
            return pid
    return None


def _has_module(pid, module_name):
    h = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        return False
    try:
        modules = (ctypes.c_void_p * 2048)()
        needed = wt.DWORD()
        if not psapi.EnumProcessModulesEx(h, modules, ctypes.sizeof(modules), ctypes.byref(needed), 0x03):
            return False
        count = needed.value // ctypes.sizeof(ctypes.c_void_p)
        for i in range(count):
            buf = ctypes.create_unicode_buffer(520)
            psapi.GetModuleFileNameExW(h, ctypes.c_void_p(modules[i]), buf, 520)
            if module_name.lower() in buf.value.lower():
                return True
        return False
    except Exception:
        return False
    finally:
        kernel32.CloseHandle(h)


# ─── Memory scanning ──────────────────────────────────────────────────────────

def scan_memory_for_key(pid, db_path):
    """Scan process memory for the SQLCipher raw key."""
    with open(db_path, "rb") as f:
        page1 = f.read(4096)

    salt = page1[:16]
    hex_pattern = re.compile(rb"x'([0-9a-fA-F]{64,192})'")

    h = kernel32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
    if not h:
        print(f"[!] Cannot open process PID={pid} (error {ctypes.get_last_error()}). Run as admin!")
        return None

    address = 0
    mbi = MEMORY_BASIC_INFORMATION()
    candidates = []

    while kernel32.VirtualQueryEx(h, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)):
        if (mbi.State == MEM_COMMIT and mbi.Protect & READABLE_PAGES and not mbi.Protect & PAGE_GUARD):
            size = mbi.RegionSize
            if 0 < size < 256 * 1024 * 1024:
                buf = ctypes.create_string_buffer(size)
                bytes_read = ctypes.c_size_t(0)
                if kernel32.ReadProcessMemory(h, ctypes.c_void_p(mbi.BaseAddress), buf, size, ctypes.byref(bytes_read)):
                    data = buf.raw[:bytes_read.value]
                    for match in hex_pattern.finditer(data):
                        hex_str = match.group(1).decode("ascii")
                        enc_key = hex_str[:64]
                        # Verify salt matches if full key+salt present
                        if len(hex_str) >= 96:
                            candidate_salt = hex_str[64:96]
                            if candidate_salt.lower() != salt.hex().lower():
                                continue
                        if enc_key not in candidates:
                            candidates.append(enc_key)

        next_addr = (mbi.BaseAddress or 0) + mbi.RegionSize
        if next_addr <= address:
            break
        address = next_addr

    kernel32.CloseHandle(h)

    # Verify candidates against the database
    for key in candidates:
        if _verify_key(key, page1):
            return key

    # If HMAC verification fails, return first candidate (try direct open)
    return candidates[0] if candidates else None


def _verify_key(enc_key_hex, page1):
    """HMAC-SHA512 verification (best-effort, SQLCipher variants differ)."""
    import hmac as hmac_mod
    salt = page1[:16]
    hmac_size = 64
    data = page1[16:len(page1) - hmac_size]
    stored_hmac = page1[len(page1) - hmac_size:]
    key_bytes = bytes.fromhex(enc_key_hex)

    for derive in [
        lambda k, s: k,
        lambda k, s: hmac_mod.new(k, s, hashlib.sha512).digest(),
        lambda k, s: hashlib.pbkdf2_hmac("sha512", k, s, 2, dklen=64),
    ]:
        try:
            hmac_key = derive(key_bytes, salt)
            for msg in [data + struct.pack("<I", 1), data, data + salt]:
                computed = hmac_mod.new(hmac_key, msg, hashlib.sha512).digest()
                if computed == stored_hmac:
                    return True
        except Exception:
            pass
    return False


# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Extract Trae Work SQLCipher key")
    parser.add_argument("--output", "-o", help="Output path for trae-key.json")
    args = parser.parse_args()

    print("=" * 60)
    print("  Trae Work — SQLCipher Key Extractor")
    print("=" * 60)

    db_path = find_database()
    if not db_path:
        print("[!] Trae Work database not found.")
        print("    Expected at: %APPDATA%/TRAE SOLO CN/ModularData/ai-agent/database.db")
        sys.exit(1)

    print(f"[+] Database: {db_path}")
    print(f"[+] Size: {os.path.getsize(db_path) / 1024 / 1024:.1f} MB")

    # Check if encrypted
    with open(db_path, "rb") as f:
        header = f.read(16)
    if header[:6] == b"SQLite":
        print("[!] Database is NOT encrypted. No key needed.")
        sys.exit(0)

    print("[*] Finding ai_agent.dll process...")
    pid = find_ai_agent_pid()
    if not pid:
        print("[!] ai_agent.dll not found in any process.")
        print("    Make sure Trae Work is running.")
        sys.exit(1)

    print(f"[+] Found PID: {pid}")
    print("[*] Scanning memory...")
    start = time.time()
    key = scan_memory_for_key(pid, db_path)
    elapsed = time.time() - start

    if not key:
        print(f"[-] No key found ({elapsed:.1f}s)")
        sys.exit(1)

    print(f"[+] Key found in {elapsed:.1f}s!")
    print(f"    enc_key = {key}")

    # Determine output path
    output = args.output
    if not output:
        # Try next to database first
        db_dir = os.path.dirname(db_path)
        candidate = os.path.join(db_dir, "trae-key.json")
        try:
            with open(candidate, "w") as f:
                f.write("")
            output = candidate
        except OSError:
            # Fall back to Token Monitor data dir
            appdata = os.environ.get("APPDATA", os.path.join(os.path.expanduser("~"), "AppData", "Roaming"))
            tm_dir = os.path.join(appdata, "Token Monitor")
            os.makedirs(tm_dir, exist_ok=True)
            output = os.path.join(tm_dir, "trae-key.json")

    result = {"key": key, "db_path": db_path, "extracted_at": time.strftime("%Y-%m-%dT%H:%M:%S")}
    with open(output, "w") as f:
        json.dump(result, f, indent=2)

    print(f"[+] Key saved to: {output}")
    print("\nToken Monitor will now be able to read Trae Work usage data.")


if __name__ == "__main__":
    main()
