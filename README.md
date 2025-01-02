# VSCode Markdown Code Runner with Jupyter-like Features

This extension provides Jupyter notebook-like functionality for running Python code blocks in markdown files.

## Result Display Logic
- [x] when click any one of the codelens, open the panel if it is not opened, and show only the result of clicked block
- [x] when click another codelens, add new result block before or after existing blocks based on its current position
- [x] when rerun a block, replace the result panel with a new one, instead of appending a new panel
- [ ] **when a block is running, the result block should stream outputs**
  - Solution Steps:
  1. streaming outputs to debug console
  2. modify function `updatePanel` and `onPartialOutput` in `extension.ts` to update specific result blocks in real time
- [ ] when user click the terminate block codelens, the streaming output should be stopped immediately
