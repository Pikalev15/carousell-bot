@echo off
cd /d "%~dp0"
echo Starting Carousell Bot at http://localhost:3000
echo Press Ctrl+C in this window to stop it.
"C:\Program Files\nodejs\node.exe" src\server.js
