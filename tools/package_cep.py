#!/usr/bin/env python3
"""Package the LuckyTwitch Markers Premiere Pro CEP extension.

Generates:
  1. dist/LuckyTwitch-Premiere-Plugin-CEP.zip
     Manual installer for Windows and macOS (includes scripts, panel, and src).
  2. dist/LuckyTwitch-Premiere-Plugin-CEP.zxp
     Signed ZXP package for 1-click install via ZXPInstaller, Anastasiy Extension Manager,
     or aescripts manager.

Usage:
  python tools/package_cep.py [--dist dist] [--skip-zxp]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CEP_ROOT = ROOT if (ROOT / "cep-panel").is_dir() else (ROOT / "premiere-plugin-cep")
PANEL_DIR = CEP_ROOT / "cep-panel"
SRC_DIR = CEP_ROOT / "src"

ZXPSIGN_BASE_URL = "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD"

# Known SHA-256 digests for ZXPSignCmd official binaries from Adobe-CEP/CEP-Resources
ZXPSIGN_SHA256 = {
    f"{ZXPSIGN_BASE_URL}/4.1.3/x64/ZXPSignCmd.exe": "ffc2223167225ce61d024eb463fc5ad1a1be16133f99ef334a646f7311916c98",
    f"{ZXPSIGN_BASE_URL}/4.1.103/win64/ZXPSignCmd.exe": "dc2e711a46504830062ac1afede1f8ee08c1e21399b6c30d7d38cf907c35bcf5",
    f"{ZXPSIGN_BASE_URL}/4.1.1/win64/ZXPSignCmd.exe": "78099a155c67776446495f7178dd3d1a99783b27e5f4e180692e35fd286a8ca4",
    f"{ZXPSIGN_BASE_URL}/4.1.3/Win32/ZXPSignCmd.exe": "bd1cec5d7b5b1079d1f7dda365026c4c0892aecc99cf7045dab1b5d71fc1f10f",
    f"{ZXPSIGN_BASE_URL}/4.1.3/macOS/ZXPSignCmd": "bc773fae0b97416fc7a462e7dadcc00270428a9913480c9b78b5606ff1cfb095",
}


def find_or_download_zxpsigncmd(cache_dir: Path) -> Path | None:
    """Find ZXPSignCmd in PATH or download platform-appropriate binary from Adobe-CEP."""
    which = shutil.which("ZXPSignCmd") or shutil.which("ZXPSignCmd.exe")
    if which:
        return Path(which)

    system = platform.system().lower()
    urls: list[str] = []
    if system == "windows":
        exe_path = cache_dir / "ZXPSignCmd.exe"
        urls = [
            f"{ZXPSIGN_BASE_URL}/4.1.3/x64/ZXPSignCmd.exe",
            f"{ZXPSIGN_BASE_URL}/4.1.103/win64/ZXPSignCmd.exe",
            f"{ZXPSIGN_BASE_URL}/4.1.1/win64/ZXPSignCmd.exe",
            f"{ZXPSIGN_BASE_URL}/4.1.3/Win32/ZXPSignCmd.exe",
        ]
    elif system == "darwin":
        exe_path = cache_dir / "ZXPSignCmd"
        urls = [
            f"{ZXPSIGN_BASE_URL}/4.1.3/macOS/ZXPSignCmd",
        ]
    else:
        # Linux fallback
        exe_path = cache_dir / "ZXPSignCmd"
        urls = [
            f"{ZXPSIGN_BASE_URL}/4.1.3/x64/ZXPSignCmd.exe",
        ]

    if exe_path.exists() and exe_path.stat().st_size > 0:
        return exe_path

    cache_dir.mkdir(parents=True, exist_ok=True)
    for url in urls:
        print(f"Downloading ZXPSignCmd from {url}...")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (LuckyTwitch-Packager)"})
            with urllib.request.urlopen(req, timeout=30) as resp, open(exe_path, "wb") as f:
                shutil.copyfileobj(resp, f)
            expected_hash = ZXPSIGN_SHA256.get(url)
            if expected_hash:
                actual_hash = hashlib.sha256(exe_path.read_bytes()).hexdigest().lower()
                if actual_hash != expected_hash:
                    exe_path.unlink(missing_ok=True)
                    raise RuntimeError(f"SHA-256 mismatch for {url}: expected {expected_hash}, got {actual_hash}")
            exe_path.chmod(0o755)
            print(f"Downloaded and verified ZXPSignCmd to {exe_path}")
            return exe_path
        except Exception as exc:
            print(f"Warning: could not download ZXPSignCmd from {url} ({exc})")
            if exe_path.exists():
                exe_path.unlink(missing_ok=True)
    return None


def stage_extension_bundle(stage_dir: Path, include_debug: bool = False) -> None:
    """Stage extension files matching the deployed CEP structure."""
    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    stage_dir.mkdir(parents=True)

    # 1. cep-panel components
    shutil.copytree(PANEL_DIR / "CSXS", stage_dir / "CSXS")
    shutil.copytree(PANEL_DIR / "js", stage_dir / "js")
    shutil.copytree(PANEL_DIR / "jsx", stage_dir / "jsx")
    shutil.copy2(PANEL_DIR / "index.html", stage_dir / "index.html")
    if include_debug and (PANEL_DIR / ".debug").exists():
        shutil.copy2(PANEL_DIR / ".debug", stage_dir / ".debug")

    # 2. shared runtime scripts from src/ into shared/
    shared_dest = stage_dir / "shared"
    shared_dest.mkdir(parents=True)
    for js in SRC_DIR.glob("*.js"):
        shutil.copy2(js, shared_dest / js.name)


def build_zip_package(out_zip: Path) -> None:
    """Create LuckyTwitch-Premiere-Plugin-CEP.zip manual installer archive."""
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    if out_zip.exists():
        out_zip.unlink()

    files_to_pack: list[tuple[Path, str]] = [
        (CEP_ROOT / "README.md", "README.md"),
        (CEP_ROOT / "install.bat", "install.bat"),
        (CEP_ROOT / "install.ps1", "install.ps1"),
        (CEP_ROOT / "install-mac.command", "install-mac.command"),
    ]

    for p in files_to_pack:
        if not p[0].exists():
            raise FileNotFoundError(f"Missing required file: {p[0]}")

    with zipfile.ZipFile(out_zip, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        # 1. Root files
        for src_path, arcname in files_to_pack:
            data = src_path.read_bytes()
            if arcname == "install-mac.command":
                # Ensure LF endings and 0755 permissions
                data = data.replace(b"\r\n", b"\n")
                zi = zipfile.ZipInfo(arcname)
                zi.external_attr = 0o755 << 16
                zf.writestr(zi, data)
            else:
                zf.writestr(arcname, data)

        # 2. cep-panel/
        for p in PANEL_DIR.rglob("*"):
            if p.is_file() and p.name not in (".DS_Store", ".debug"):
                rel = p.relative_to(CEP_ROOT)
                zf.write(p, str(rel).replace("\\", "/"))

        # 3. src/
        for p in SRC_DIR.rglob("*"):
            if p.is_file() and p.name != ".DS_Store":
                rel = p.relative_to(CEP_ROOT)
                zf.write(p, str(rel).replace("\\", "/"))

    print(f"Created ZIP: {out_zip} ({out_zip.stat().st_size:,} bytes)")


def build_zxp_package(
    stage_dir: Path,
    out_zxp: Path,
    zxpsign: Path,
    cert_path: Path,
    password: str,
    tsa_url: str | None,
) -> None:
    """Create and sign LuckyTwitch-Premiere-Plugin-CEP.zxp using ZXPSignCmd."""
    out_zxp.parent.mkdir(parents=True, exist_ok=True)
    if out_zxp.exists():
        out_zxp.unlink()

    # 1. Generate certificate if missing
    if not cert_path.exists():
        print("Generating self-signed certificate...")
        cert_path.parent.mkdir(parents=True, exist_ok=True)
        gen_cmd = [
            str(zxpsign),
            "-selfSignedCert",
            "US",
            "CA",
            "LuckyTwitch",
            "LuckyTwitch Markers",
            password,
            str(cert_path),
        ]
        res = subprocess.run(gen_cmd, capture_output=True, text=True)
        if res.returncode != 0:
            raise RuntimeError(f"Certificate generation failed: {res.stderr or res.stdout}")
        print(f"Certificate created: {cert_path}")

    # 2. Sign extension package
    print("Signing ZXP package...")
    sign_cmd = [
        str(zxpsign),
        "-sign",
        str(stage_dir),
        str(out_zxp),
        str(cert_path),
        password,
    ]
    if tsa_url:
        sign_cmd.extend(["-tsa", tsa_url])

    res = subprocess.run(sign_cmd, capture_output=True, text=True)
    if res.returncode != 0 and tsa_url:
        print(f"Signing with TSA ({tsa_url}) failed: {res.stderr or res.stdout.strip()}")
        print("Retrying signing without TSA...")
        sign_cmd = [
            str(zxpsign),
            "-sign",
            str(stage_dir),
            str(out_zxp),
            str(cert_path),
            password,
        ]
        res = subprocess.run(sign_cmd, capture_output=True, text=True)

    if res.returncode != 0:
        raise RuntimeError(f"ZXP signing failed: {res.stderr or res.stdout}")

    # 3. Verify ZXP package
    verify_cmd = [str(zxpsign), "-verify", str(out_zxp)]
    v_res = subprocess.run(verify_cmd, capture_output=True, text=True)
    if v_res.returncode != 0:
        print(f"Warning: verification reported: {v_res.stderr or v_res.stdout.strip()}")
    else:
        print("ZXP signature verified successfully.")

    print(f"Created ZXP: {out_zxp} ({out_zxp.stat().st_size:,} bytes)")


def main() -> int:
    parser = argparse.ArgumentParser(description="Package LuckyTwitch Premiere CEP panel")
    parser.add_argument("--dist", type=Path, default=ROOT / "dist", help="Output directory")
    parser.add_argument("--skip-zxp", action="store_true", help="Only build the ZIP package")
    parser.add_argument("--cert", type=Path, default=ROOT / "build" / "luckytwitch-cert.p12", help="Cert path")
    parser.add_argument("--password", default=os.environ.get("CEP_CERT_PASSWORD") or "luckytwitch", help="Cert password")
    parser.add_argument("--tsa", default="http://timestamp.digicert.com", help="Timestamp server")
    args = parser.parse_args()

    args.dist.mkdir(parents=True, exist_ok=True)
    zip_path = args.dist / "LuckyDownloader-Premiere-Plugin-CEP.zip"
    zxp_path = args.dist / "LuckyDownloader-Premiere-Plugin-CEP.zxp"
    legacy_zip = args.dist / "LuckyTwitch-Premiere-Plugin-CEP.zip"
    legacy_zxp = args.dist / "LuckyTwitch-Premiere-Plugin-CEP.zxp"

    print("--- Packaging Premiere CEP extension ---")
    build_zip_package(zip_path)
    shutil.copy2(zip_path, legacy_zip)
    print(f"Created legacy ZIP alias: {legacy_zip}")

    if args.skip_zxp:
        print("Skipping ZXP packaging as requested.")
        return 0

    cache_dir = ROOT / "build" / "tools"
    zxpsign = find_or_download_zxpsigncmd(cache_dir)
    if not zxpsign:
        print("Error: ZXPSignCmd is not available. Cannot build signed ZXP package.", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory() as tmp_stage:
        stage_dir = Path(tmp_stage) / "bundle"
        stage_extension_bundle(stage_dir)
        build_zxp_package(
            stage_dir=stage_dir,
            out_zxp=zxp_path,
            zxpsign=zxpsign,
            cert_path=args.cert,
            password=args.password,
            tsa_url=args.tsa,
        )
        shutil.copy2(zxp_path, legacy_zxp)
        print(f"Created legacy ZXP alias: {legacy_zxp}")

    print("--- Packaging complete ---")
    return 0


if __name__ == "__main__":
    sys.exit(main())
