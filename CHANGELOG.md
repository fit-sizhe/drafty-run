# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- [ ] make sure "Run" code does not update result panel top
- [ ] code-result block binding
  - bindingId format: 
    - DRAFTY-ID-XXX-Y, i.e. "DRAFTY-ID" + unique 3-digit number + 1 digit number. 
    - the three parts are called head, belly, and tail
  - "Bind" codelens 
    - adds a comment beneath code fence of a format DRAFTY-ID-XXX-0 if NO ID presents
    - generate new ID only when "bindingID" does not exist in the type of `CodeBlock`
    - check if there is a result block in webview panel that has the same ID, if not, create an empty result block
    - If there are some result blocks with the same ID head and belly, create such an empty result block at a location that respects the tail order.
    - For example, if there are already two result blocks with IDs of DRAFTY-ID-XXX-1 and DRAFTY-ID-XXX-2, and current ID in your code block is DRAFTY-ID-XXX-3, the empty result block should be placed right after the two existing result blocks
  - "Run" codelens
    - before executing the code, check the order of DRAFTY-ID in both editor and webview panel, based on which rearrange the order of result blocks 
    - when rearranging, result blocks with the same ID head and belly staty together
    - make sure that execution results are sending to the result block of the same element ID.
  - "Bind All" codelens binds all code blocks to result block elements in the result panel
    - create new result blocks by following the rule above
    - User might accidentally delete the comment line that has DRAFTY-ID in it. If so, "Bind All" should check if each codeblock has bindingId and makes it re-appear

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
