@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Install the Python environment first. See README.md.
  pause
  exit /b 1
)
if not exist "models\pin-v2\model.safetensors" (
  echo Trained model not found at models\pin-v2. See README.md.
  pause
  exit /b 1
)
set HF_HUB_OFFLINE=1
".venv\Scripts\python.exe" local_tts.py --model "models\pin-v2" --speaker pin
pause
