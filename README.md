# VSCode Markdown Code Runner with Jupyter-like Features

This extension provides Jupyter notebook-like functionality for running Python code blocks in markdown files.

## Result Display Logic
- [x] when click any one of the codelens, open the panel if it is not opened, and show only the result of clicked block
- [x] when click another codelens, add new result block before or after existing blocks based on its current position
- [x] when rerun a block, replace corresponding result block with a new one, instead of appending a new block
- [x] if codelens from different code blocks are clicked, multiple code result panels should be in webView at the same time
- [x] **when a block is running, the result block should stream outputs**
  - [x] text output should be printed line-by-line
  - [x] visual outputs should be updated on the same image
- [x] when user click the terminate block codelens, the streaming output should be stopped immediately
