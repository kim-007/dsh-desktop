# DSH Desktop UOS 1070 ARM64 DEB Packaging Design

## Goal

Produce an installable `arm64` Debian package for DSH Desktop that targets UnionTech UOS Desktop Professional 1070 on a Kirin 990 processor. The final artifact will be copied to the task's `outputs` directory and accompanied by a SHA-256 checksum.

## Compatibility target

- Operating system: UnionTech UOS Desktop Professional 1070
- Processor family: Kirin 990, compatible with ARMv8-A AArch64
- Debian package architecture: `arm64`
- Linux machine architecture: `aarch64`
- Runtime baseline: Debian 10-era ARM64 userspace, including glibc 2.28
- Application runtime: the versions pinned by the repository lockfile

The package will not claim support for `amd64`, LoongArch64, SW64, or MIPS64el. It will not replace or rename the existing amd64 artifact, change the application's security model, or disable Electron sandboxing on the user's system.

## Selected build approach

The package will be built and exercised on GitHub's native `ubuntu-24.04-arm` hosted runner. The application build itself will run inside a native `linux/arm64` Debian 10 container. This avoids QEMU instruction emulation and prevents an amd64 executable from being mislabeled as an arm64 Debian package.

QEMU cross-building remains a fallback only if the native hosted runner becomes unavailable. A package that is merely assembled on amd64 without executing its ARM64 contents is not an acceptable deliverable.

## Packaging configuration

The existing Linux Debian configuration and runtime dependency list will be shared with amd64. ARM64-specific additions will include:

- a `package:linux:arm64` script that requires Linux `arm64` before packaging
- Electron Builder's `--arm64` target
- a stable `dsh-desktop-linux-arm64.deb` artifact name
- an ARM64 verifier invocation that expects Debian architecture `arm64` and an AArch64 ELF executable

The existing `package:linux:amd64` command and `dsh-desktop-linux-amd64.deb` output will remain unchanged. Architecture-specific artifact naming will be explicit so the two packages cannot overwrite one another.

## Reproducible build environment

A dedicated ARM64 Debian 10 container recipe will:

1. Install the same compiler, Debian packaging, X11, and smoke-test prerequisites used by the verified amd64 build.
2. Install the ARM64 distribution of the repository's selected Node.js version.
3. Install dependencies from `package-lock.json` with `npm ci`.
4. Run application tests and TypeScript checking.
5. Build the production Electron application and create the arm64 DEB.
6. Verify, install, and start the package inside the same native ARM64 container.

The GitHub workflow will use the native ARM64 runner for the package job and upload only the verified `dsh-desktop-linux-arm64.deb` artifact.

## Verification

The ARM64 deliverable must pass:

- repository unit tests
- TypeScript type checking
- Electron/Vite production build
- Debian control metadata reports `Package: dsh-desktop` and `Architecture: arm64`
- package contents include the desktop entry, brand icon, executable, application resources, and Harness resources
- the installed main executable reports `ELF 64-bit` and `ARM aarch64` or `AArch64`
- clean Debian 10 ARM64 dependency resolution and package installation
- a 45-second virtual-display launch smoke test without missing-library or executable-format failure
- SHA-256 checksum verification after downloading the artifact

The automated environment cannot prove every behavior of the user's physical Kirin 990/UOS installation. Final device acceptance is that the package installs without an architecture error, the launcher shows the application, the main window opens, and the bundled Harness reaches its ready state.

## Failure handling

- If GitHub cannot allocate the native ARM64 runner, stop and report the runner failure before considering the QEMU fallback.
- If a dependency lacks an ARM64 release, identify the exact module or binary and do not silently reuse an amd64 file.
- If any packaged executable reports x86-64, fail verification immediately.
- If an ARM64 executable requires a userspace newer than Debian 10, report the incompatible file and required symbol version instead of weakening the baseline.
- If the application remains alive but emits expected headless-container D-Bus or GPU messages, the smoke test may pass only when it reaches the full timeout; early termination remains a failure.

## Deliverables

- `dsh-desktop-linux-arm64.deb`
- `dsh-desktop-linux-arm64.deb.sha256`
- a verification summary listing the test, metadata, architecture, installation, and launch checks that passed

Repository signing, UOS application-store publication, and automatic-update feeds are outside this task.
