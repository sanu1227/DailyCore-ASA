@echo off
set "RIN_CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%RIN_CHROME%" set "RIN_CHROME=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if exist "%RIN_CHROME%" start "" "%RIN_CHROME%" "chrome://extensions/"
start "" explorer.exe "%~dp0extensions\rin-eclass-sync"
