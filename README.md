# VSCode Markdown Code Runner with Jupyter-like Features

This extension provides Jupyter notebook-like functionality for running Python code blocks in markdown files.

## Implementation Plan

### 1. Core Python Execution Enhancement ✅
- [x] Implement output type handling system
  - [x] Text output (stdout/stderr)
  - [x] Image output (matplotlib figures, plots)
  - [x] Rich output (HTML, LaTeX)
  - [x] Error messages
- [x] Add support for asynchronous execution
- [x] Implement execution state management
  - [x] Variable persistence between cells
  - [x] Workspace context preservation

### 2. Display and UI Components
- [x] Create WebView panel architecture
  - [x] Custom styling with VSCode theme integration
  - [x] Responsive layout for different output types
- [x] Implement output rendering components
  - [x] Code block display with syntax highlighting
  - [x] Text output formatting
  - [x] Image display with proper scaling
  - [x] Error message formatting with stack traces
- [ ] Add a button right above each code block in opened markdown to allow user to (re)run current block
  - if rerun, update corresponding result block in opened pane
- [ ] Add a button in opened result pane to interactively find virtual and conda environments


## Development Workflow
1. Implement features incrementally, starting with core execution
2. Add tests for each component
3. Gather user feedback and iterate on implementation
4. Maintain backward compatibility
5. Regular performance testing and optimization

## Testing Strategy
- Unit tests for core functionality
- Integration tests for Python execution
- End-to-end tests for UI components
- Performance benchmarks
- Cross-platform testing

## Future Enhancements
- Support for other languages (R, Julia)
- Interactive widgets
- Real-time collaboration
- Remote kernel support
- Custom output formatters
