#!/usr/bin/env bash
set -eu
here="$(cd -- "$(dirname -- "$0")" && pwd)"
script="$(cygpath -w "$here/setup-local-master-password.ps1")"
export DSH_LOCAL_SETUP_SCRIPT="$script"
powershell.exe -NoProfile -NonInteractive -Command 'Start-Process -FilePath powershell.exe -ArgumentList @("-NoProfile","-STA","-ExecutionPolicy","Bypass","-File",$env:DSH_LOCAL_SETUP_SCRIPT)'
