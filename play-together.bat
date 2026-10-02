@echo off
rem Starts Brickyard for up to five players on the same WiFi. Keep this window open while you play.
title Brickyard - play together
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Playing together needs Node.js. Get it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
node server.js %*
pause
