# Drafty: VSCode Markdown Code Runner with Jupyter-like Features

This extension provides Jupyter notebook-like functionality for running code blocks in markdown files.

## Features

- [x] Auto-focus on "running" code block 
- [x] Scrollable result blocks by setting "Max result height"
- [ ] Result block title automaticall set by comments preceded by "#|"
- [ ] State saver/loader:
  - [x] a button save current state to json
  - [ ] a simple folder selector for where the json should be stored
  - [ ] a state loader that chooses which state json file to load

## Result Display Logic
- [x] when click any one of the codelens, open the panel if it is not opened, and show only the result of clicked block
- [x] when click another codelens, add new result block before or after existing blocks based on its current position
- [x] when rerun a block, replace corresponding result block with a new one, instead of appending a new block
- [x] if codelens from different code blocks are clicked, multiple code result panels  be in webView at the same time
- [x] **when a block is running, the result block  stream outputs**
  - [x] text output  be printed line-by-line
  - [x] visual outputs  be updated on the same image
- [x] when user click the terminate block codelens, the streaming output  be stopped immediately
