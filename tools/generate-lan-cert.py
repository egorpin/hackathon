"""Issue an offline LAN TLS certificate using OpenSSL (no Python packages needed).

Usage: python tools/generate-lan-cert.py 192.168.1.10 [192.168.1.11 ...]
Or: python tools/generate-lan-cert.py --hostname mars.home.arpa
The CA is retained across runs so clients need to trust it only once.
"""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile


def hostname(value):
    name = value.lower().rstrip(".")
    labels = name.split(".")
    if len(name) > 253 or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label)
                              for label in labels):
        raise argparse.ArgumentTypeError("Use a DNS name without scheme, port or wildcard")
    try:
        ipaddress.ip_address(name)
    except ValueError:
        return name
    raise argparse.ArgumentTypeError("Pass IPv4 addresses as positional arguments, not --hostname")


def find_openssl():
    found = shutil.which("openssl")
    if found:
        return found
    # Git for Windows includes OpenSSL, but normally doesn't add it to PATH.
    for root in (Path(os.environ.get("ProgramFiles", "C:/Program Files")) / "Git",
                 Path(os.environ.get("LOCALAPPDATA", "C:/Users/Default/AppData/Local")) / "Programs/Git"):
        for relative in ("usr/bin/openssl.exe", "mingw64/bin/openssl.exe"):
            candidate = root / relative
            if candidate.is_file():
                return str(candidate)
    raise SystemExit("OpenSSL not found. Install OpenSSL or Git for Windows before preparing the demo.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("addresses", nargs="*", type=ipaddress.IPv4Address,
                        help="server LAN IPv4 addresses from ipconfig")
    parser.add_argument("--hostname", action="append", type=hostname, default=[],
                        help="stable local DNS/mDNS name; repeat for additional names")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "certs")
    args = parser.parse_args()
    if not args.addresses and not args.hostname:
        parser.error("Provide at least one LAN IPv4 address or --hostname")
    openssl = find_openssl()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(output, 0o700)
    ca_key, ca_cert = output / "ca.key", output / "ca.crt"
    if ca_key.exists() != ca_cert.exists():
        raise SystemExit("Incomplete CA: both ca.key and ca.crt must exist. Restore the missing file first.")

    def run(*arguments):
        subprocess.run([openssl, *map(str, arguments)], check=True)

    # Keep incomplete/generated private keys in a private temporary directory.
    with tempfile.TemporaryDirectory(dir=output) as temporary:
        work = Path(temporary)
        if not ca_key.exists():
            run("req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650",
                "-subj", "/CN=Mars Colony LAN Demo CA", "-keyout", work / "ca.key",
                "-out", work / "ca.crt", "-addext", "basicConstraints=critical,CA:TRUE,pathlen:0",
                "-addext", "keyUsage=critical,keyCertSign,cRLSign")
            os.chmod(work / "ca.key", 0o600)
            (work / "ca.key").replace(ca_key)
            (work / "ca.crt").replace(ca_cert)
        addresses = sorted({"127.0.0.1", *map(str, args.addresses)})
        names = sorted({"localhost", *args.hostname})
        san = ",".join([*(f"DNS:{name}" for name in names), *(f"IP:{address}" for address in addresses)])
        extensions = work / "server.ext"
        extensions.write_text(
            "basicConstraints=critical,CA:FALSE\n"
            "keyUsage=critical,digitalSignature,keyEncipherment\n"
            "extendedKeyUsage=serverAuth\n"
            f"subjectAltName={san}\n", encoding="ascii")
        run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-sha256",
            "-subj", "/CN=Mars Colony LAN", "-keyout", work / "server.key", "-out", work / "server.csr")
        run("x509", "-req", "-in", work / "server.csr", "-CA", ca_cert, "-CAkey", ca_key,
            "-set_serial", "0x" + secrets.token_hex(16), "-days", "365", "-sha256",
            "-extfile", extensions, "-out", work / "server.crt")
        run("verify", "-CAfile", ca_cert, "-purpose", "sslserver", work / "server.crt")
        os.chmod(work / "server.key", 0o600)
        for name in ("server.key", "server.crt"):
            (work / name).replace(output / name)
    print(f"Certificates: {output}\nTrust ONLY ca.crt on clients; keep both .key files private.")
    print("Valid hosts: " + ", ".join([*names, *addresses]))
    if args.hostname:
        print("Configure local DNS/mDNS to resolve these names to the server's current LAN IP.")
        print("Changing the IP does not require reissuing the certificate when connecting by name.")
    print("After reissuing: docker compose --project-directory . -f lan/compose.https.yaml up -d --no-build --pull never --force-recreate client")


if __name__ == "__main__":
    main()
