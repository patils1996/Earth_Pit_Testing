@echo off
title Earth Pit Manager (EPM Pro) - BPCL Earthing Testing
echo =======================================================
echo    Earth Pit Manager (EPM Pro)
echo    Digital Earth Pit Testing Reports & Management
echo =======================================================
echo.
echo Launching server and opening application in browser...
timeout /t 1 /nobreak >nul
start "" "http://localhost:5000"
python server.py
pause
