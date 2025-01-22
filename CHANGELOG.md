# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- [ ] move `binding_utils` to `src/ops`
- [ ] reorg codebase for 0.2
- [ ] update props definitions
- [ ] test props `removeOrphanedBlocks`
- [ ] test props `defaultPath`
- [ ] test props `savingRule`

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
