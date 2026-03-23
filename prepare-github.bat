@echo off
chcp 65001 >nul
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
  echo [ERRO] Git nao encontrado. Instala "Git for Windows":
  echo   https://git-scm.com/download/win
  echo Depois fecha e abre o terminal e corre este script outra vez.
  pause
  exit /b 1
)

if not exist ".git" (
  git init -b main
) else (
  echo Repositorio Git ja existe.
)

git add .
git status
echo.
set /p CONFIRM=Fazer commit inicial? (S/N): 
if /i not "%CONFIRM%"=="S" exit /b 0

git commit -m "Initial commit: Filmes, Series e Novelas Portuguesas Addon Stremio"

echo.
echo --- Proximos passos no GitHub.com ---
echo 1. New repository ^> cria vazio ^(sem README^).
echo 2. Na pasta deste projeto, corre ^(substitui USER e REPO^):
echo    git remote add origin https://github.com/USER/REPO.git
echo    git push -u origin main
echo.
echo Se pedir login: GitHub recomenda Personal Access Token em vez da password.
pause
