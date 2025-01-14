# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

- [ ] code-result block binding
- [ ] env info cache

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
