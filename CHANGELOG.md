# Changelog

All notable changes to this project will be documented in this file.

## [0.2.2] - 2025-06-07

- **Project Virtual Environment Detection**: Automatically detect `.venv` folders in project root and parent directories (poetry, uv, etc.)
- **Stream Directive for Plot Control**: New `#| stream: true/false` directive to control image output behavior
  - `stream: true` - Real-time plot updates (overwrites previous images for animations)
  - `stream: false` or omitted - Display all plots separately
- **Clickable Result Block Headers**: Click result block headers to navigate to corresponding code blocks in markdown
- **Run All CodeLens**: New "Run All" button on each Python code block to execute all blocks sequentially
- **Improved Error Handling**: Better dependency checking and user-friendly error messages for missing ipykernel/ipython
- **Webview Display Precision**: Execution times now display with 4 decimal places
- **Missing Dependencies**: Added proactive checks for ipykernel installation with helpful installation instructions

## [0.2.1] - 2025-05-07

- [x] fix issue with directives/comments before %% magic commands
- [x] test pyinstrument with extension

## [0.2.0] - 2025-02-14

- [x] reorg codebase for 0.2
- [x] add `Goto` codelens for goto corresponding result block 
- [x] add support of `Plotly.js` to allow interactive curve/scatter/surface plotting
- [x] design a comment directive set for rendering interactive plot
- [x] complete interactive plot loading/saving

## [0.1.7] - 2025-02-01

- [x] allow title appearance in result blocks
- [x] update props definitions
- [x] patch `scrollIntoView` logic
- [x] test props `defaultPath`
- [x] test props `savingRule`

## [0.1.6] - 2025-01-22

- [x] code-result block binding
  - "Run" codelens
    - [x] adds a comment beneath code fence of a format DRAFTY-ID-XXX-0 if NO ID presents
    - [x] generate new ID only when "bindingID" does not exist in the type of `CodeBlock`
    - [x] make sure that execution results are sending to the result block of the same element ID.
    - [x] result blocks with the same belly number are moved/rearranged as a group 
    - [x] update order of result blocks in the same belly group by the order of tail numbers
    - [x] the order of belly groups is sorted by the first appearance of each belly number

## [0.1.5] - 2025-01-21

- [x] replace `blockId` with `bindingId`
  - bindingId format: 
    - DRAFTY-ID-XXX-Y, i.e. "DRAFTY-ID" + unique 3-digit number + 1 digit number. 
    - the three parts are called head, belly, and tail
- [x] refactor `commands.ts`
  - functions are shaken off the script and placed in `src/ops/`
  - add `binding_utils.ts` that contains utility functions for managing `bindingId`

## [0.1.4] - 2025-01-15

- make env switch consistent btw runs
- add `Refresh` button to refresh python env the system has

## [0.1.3] - 2025-01-14

- python env info cache
- add zeromq binaries in pkg (0.1.2 is not deprecated)

## [0.1.2] - 2025-01-13

- zeromq comm. with IPython kernel

## [0.1.1] - 2025-01-11

- Reorg `env_setup.ts` so that `conda` can be found on Windows
- Rearrange Panel Top GUI to make buttons less crowded
- Use child_process to maintain single Python process for each MD doc
- Terminate cell execution by writing `raise KeyboardInterrupt` to stdin (not effective)

## [0.1.0-alpha] - 2025-01-08

### Added
- Usage tutorial in [README.md](./README.md)
- OS-specific environment finding functionality
- Initial file loader/saver implementation
- Basic project setup and configuration
