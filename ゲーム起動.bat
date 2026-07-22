@echo off
cd /d C:\KaniNingen-Game
start "KaniNingen Server" cmd /k "npx http-server . -p 8021 -c-1"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:8021/infinite-world-sandbox.html"
