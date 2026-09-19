; VistaVerge 安装页品牌定制
;
; 本文件由 tauri.conf.json 的 bundle.windows.nsis.installerHooks 指定，
; 在 tauri 的 installer.nsi 顶部（!include MUI2.nsh 之后、MUI 页面宏之前）被 !include。
; 因此这里的 !define 能覆盖 Modern UI 的默认页面文案。
;
; 纪律：只改文案与品牌提示，不改安装逻辑、不绕过 UAC / SmartScreen。
; 中文文案放在 customLanguageFiles 的 SimpChinese.nsh 里（LangString），
; 本文件保持纯 ASCII，避免脚本编码差异导致乱码。

; —— 欢迎页 ——
!define MUI_WELCOMEPAGE_TITLE "$(vvWelcomeTitle)"
!define MUI_WELCOMEPAGE_TEXT "$(vvWelcomeText)"

; —— 完成页 ——
!define MUI_FINISHPAGE_TITLE "$(vvFinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(vvFinishText)"

; —— 安装过程品牌提示（插入到 Install 区段末尾）——
!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "$(vvPostInstall)"
!macroend
