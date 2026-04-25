# Windows setup

`squads-cli` runs on Windows. There are two install paths — pick the one that matches how you'd ship to your users.

## Path A — Native Windows (PowerShell)

For users who prefer to stay on Windows-native tooling.

### Install

1. **Node.js 18+** — https://nodejs.org (the LTS installer is fine)
2. **Git for Windows** — https://git-scm.com/download/win
3. **squads-cli**:
   ```powershell
   npm install -g squads-cli
   squads --version
   ```

### Smoke test

Verify the install with the shipped script:

```powershell
git clone https://github.com/agents-squads/squads-cli.git
cd squads-cli
pwsh scripts/windows-smoke-test.ps1
```

This runs an end-to-end check: install, init, list, dry-run.

## Path B — WSL2 (Linux on Windows)

For developers who want a Linux shell. This is what most Windows devs use day-to-day.

### Install

1. **Enable WSL2** (one-time, in elevated PowerShell):
   ```powershell
   wsl --install
   # Reboot, then open the Ubuntu shell
   ```
2. **Inside Ubuntu**, follow the standard Linux instructions:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs git
   npm install -g squads-cli
   ```

### Tier 2 services in WSL2

Docker Desktop integrates with WSL2 — once installed, `docker` works inside the Ubuntu shell. Tier 2 setup is identical to native Linux.

## Remote testing via SSH

If you have a Windows machine you want to drive from another machine (e.g. testing from a Mac):

### One-time setup on the Windows machine (elevated PowerShell)

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service -Name sshd -StartupType Automatic

# Allow SSH through the firewall
New-NetFirewallRule -Name sshd -DisplayName 'OpenSSH Server' `
    -Enabled True -Direction Inbound -Protocol TCP `
    -Action Allow -LocalPort 22

# Find your LAN IP
ipconfig | Select-String "IPv4"
```

### From the remote machine

```bash
ssh <windows-username>@<windows-ip>
# default shell is cmd.exe; switch to PowerShell:
powershell
```

The smoke script runs the same way over SSH as locally.

## Troubleshooting

### `squads: command not found`
After global npm install, the npm prefix bin directory needs to be on `PATH`. Restart your shell or run:
```powershell
$env:Path += ";$(npm config get prefix)"
```

### Long path errors
Windows has a default 260-char path limit that breaks deep `node_modules` trees. Enable long paths once:
```powershell
# Elevated PowerShell
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
    -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force
```

### `Set-ExecutionPolicy` blocks scripts
PowerShell may refuse to run `.ps1` files. For a one-time smoke run:
```powershell
pwsh -ExecutionPolicy Bypass -File scripts/windows-smoke-test.ps1
```

### Tier 2 needs Docker Desktop
Tier 2 (Postgres + Redis + API + Bridge) requires Docker Desktop. Note: Docker Desktop **does not work inside a virtual machine** that uses nested virtualization (UTM, Parallels in some configs) — install on bare-metal Windows or use WSL2 + Docker Desktop.

## Known limitations

- **Tier 2 image availability**: At the time of writing, public Docker images for `squads-bridge` and `squads-api` are not yet published. Tier 2 currently requires building locally from the `agents-squads` source tree. See the [Tier 2 epic](https://github.com/agents-squads/squads-cli/issues) for status.
- **Native shell only**: The `squads` binary works in PowerShell, cmd, and WSL2. Older Windows shells (Windows 7 cmd, etc.) are not supported.
