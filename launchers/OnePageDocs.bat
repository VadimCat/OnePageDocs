@echo off
rem Opens OnePageDocs in Edge (Edge/Chrome can write straight into folders).
rem Uses index.html next to this file when the repo is cloned, otherwise the hosted copy.
set "APP=%~dp0..\index.html"
if exist "%APP%" (
  start "" msedge "%APP%"
) else (
  start "" msedge "https://vadimcat.github.io/OnePageDocs/"
)
