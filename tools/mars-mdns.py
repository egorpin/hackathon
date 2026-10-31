"""Windows LAN announcer. Runs outside Docker/WSL; never uses internet discovery.

Requires requirements-mdns.txt in a Windows Python environment.
"""
import argparse
import ipaddress
import json
import logging
import platform
import signal
import subprocess
import threading

HOST = "mars.local."
SERVICE = "Mars Colony._https._tcp.local."


def windows_interfaces():
    # Physical adapters only: never publish Docker, WSL, VPN or loopback addresses.
    script = r"""
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $rows = @(Get-NetAdapter -Physical | Where-Object Status -eq 'Up' | ForEach-Object {
        $adapter = $_
        Get-NetIPAddress -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource } |
            ForEach-Object { [PSCustomObject]@{name=$adapter.Name; address=$_.IPAddress} }
    })
    ConvertTo-Json -InputObject $rows -Compress
    """
    result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                            check=True, capture_output=True, encoding="utf-8", timeout=20)
    rows = json.loads(result.stdout.lstrip("\ufeff").strip() or "[]")
    return [row for row in rows if not ipaddress.IPv4Address(row["address"]).is_loopback
            and not ipaddress.IPv4Address(row["address"]).is_unspecified]


def select_interface(rows, requested=None):
    if requested:
        rows = [row for row in rows if row["name"].casefold() == requested.casefold()]
    names = {row["name"] for row in rows}
    if len(names) != 1:
        choices = ", ".join(sorted(names)) or "none"
        raise ValueError(f"Select one connected physical adapter with --interface. Available: {choices}")
    return next(iter(names)), tuple(sorted({row["address"] for row in rows}))


class Announcement:
    def __init__(self, addresses, port):
        from zeroconf import IPVersion, ServiceInfo, Zeroconf
        self.zc = Zeroconf(interfaces=list(addresses), ip_version=IPVersion.V4Only)
        self.info = ServiceInfo("_https._tcp.local.", SERVICE, parsed_addresses=list(addresses),
                                port=port, server=HOST, properties={"path": "/"},
                                host_ttl=30, other_ttl=30)
        try:
            # Fail on a duplicate instance; never silently rename the public URL.
            self.zc.register_service(self.info, allow_name_change=False)
        except BaseException:
            self.zc.close()
            raise

    def close(self):
        try:
            self.zc.unregister_service(self.info)
        finally:
            self.zc.close()


def serve(stop, discover, publish, port, requested=None, interval=3):
    current, announcement = None, None
    previous_error = None
    try:
        while not stop.is_set():
            try:
                selected = select_interface(discover(), requested)
                if selected != current:
                    if announcement:
                        announcement.close()
                        announcement = None
                    current = None
                    announcement = publish(selected[1], port)
                    current = selected
                    logging.info("https://mars.local:%s -> %s (%s)", port, ", ".join(current[1]), current[0])
                previous_error = None
            except (ValueError, OSError, subprocess.SubprocessError) as error:
                if announcement:
                    announcement.close()
                    announcement, current = None, None
                message = str(error)
                if message != previous_error:
                    logging.warning("Waiting for LAN: %s", message)
                    previous_error = message
            stop.wait(interval)
    finally:
        if announcement:
            announcement.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--interface", help="Windows adapter name, e.g. Wi-Fi; auto-select if only one is up")
    parser.add_argument("--port", type=int, default=8443)
    parser.add_argument("--list-interfaces", action="store_true")
    parser.add_argument("--open-browser", action="store_true")
    args = parser.parse_args()
    if platform.system() != "Windows":
        parser.error("Run this utility with Windows Python, outside WSL and Docker")
    if not 1 <= args.port <= 65535:
        parser.error("Port must be between 1 and 65535")
    if args.list_interfaces:
        print(json.dumps(windows_interfaces(), ensure_ascii=False, indent=2))
        return
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    stop = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    opened = False

    def publish(addresses, port):
        nonlocal opened
        result = Announcement(addresses, port)
        if args.open_browser and not opened:
            import webbrowser
            webbrowser.open(f"https://mars.local:{port}")
            opened = True
        return result

    try:
        serve(stop, windows_interfaces, publish, args.port, args.interface)
    except Exception as error:
        logging.error("mDNS stopped: %s. Check UDP 5353 and that only one server announces mars.local.", error)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
