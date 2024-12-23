# VSCode Markdown Code Runner with Jupyter-like Features

This extension provides Jupyter notebook-like functionality for running Python code blocks in markdown files.

## Result Display Logic
- when click any one of the codelens, open the panel if it is not opened, and show only the result of clicked block
- when click another codelens, add new result block before or after existing blocks based on its current position
- when rerun a block, replace the result panel with a new one, instead of appending a new panel

## Future Enhancements
- Support for other languages (R, Julia)
- Interactive widgets
- Real-time collaboration
- Remote kernel support
- Custom output formatters
