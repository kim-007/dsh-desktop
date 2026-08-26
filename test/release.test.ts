import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')
const execFileAsync = promisify(execFile)

type VerifierResult = {
  status: number
  stdout: string
  stderr: string
}

const withVerifierFixture = async (
  run: (fixture: {
    run: (architecture?: string, env?: Record<string, string>) => Promise<VerifierResult>
    markerPath: string
  }) => Promise<void>
) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'verify-linux-deb-'))
  const binPath = path.join(fixtureRoot, 'bin')
  const debPath = path.join(fixtureRoot, 'fixture.deb')
  const markerPath = path.join(fixtureRoot, 'dpkg-called')
  await writeFile(debPath, 'fixture')
  await mkdir(binPath, { recursive: true })
  await writeFile(
    path.join(binPath, 'dpkg-deb'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ -n "\${DPKG_MARKER:-}" ]]; then : > "$DPKG_MARKER"; fi
case "$1" in
  -f)
    if [[ "$3" == Architecture ]]; then
      printf '%s\\n' "\${FAKE_ARCH:-amd64}"
    else
      printf 'dsh-desktop\\n'
    fi
    ;;
  -c)
    printf '%s\\n' 'usr/share/applications/dsh-desktop.desktop' 'opt/DSH Desktop/dsh-desktop' 'opt/DSH Desktop/resources/harness-node-entry.mjs'
    ;;
  -x)
    mkdir -p "$3/opt/DSH Desktop"
    : > "$3/opt/DSH Desktop/dsh-desktop"
    ;;
  *) exit 2 ;;
esac
`
  )
  await writeFile(
    path.join(binPath, 'readelf'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '  Machine: %s\\n' "\${FAKE_MACHINE:-Advanced Micro Devices X86-64}"
`
  )
  await chmod(path.join(binPath, 'dpkg-deb'), 0o755)
  await chmod(path.join(binPath, 'readelf'), 0o755)

  const runVerifier = async (
    architecture?: string,
    env: Record<string, string> = {}
  ): Promise<VerifierResult> => {
    try {
      const result = await execFileAsync(
        '/bin/bash',
        [path.join(projectRoot, 'scripts', 'verify-linux-deb.sh'), debPath, ...(architecture ? [architecture] : [])],
        {
          env: {
            ...process.env,
            PATH: `${binPath}:${process.env.PATH ?? ''}`,
            DPKG_MARKER: markerPath,
            ...env
          }
        }
      )
      return { status: 0, stdout: result.stdout, stderr: result.stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return {
        status: typeof failure.code === 'number' ? failure.code : 1,
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? ''
      }
    }
  }

  try {
    await run({ run: runVerifier, markerPath })
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true })
  }
}

const releaseAssets = [
  'dsh-desktop-mac-arm64.dmg',
  'dsh-desktop-mac-x64.dmg',
  'dsh-desktop-windows-x64-setup.exe'
]

describe('GitHub release contract', () => {
  it('packages a UOS-compatible Linux amd64 deb', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      scripts: Record<string, string>
      build: {
        linux: {
          target: Array<{ target: string; arch: string[] }>
          category: string
          icon: string
          executableName: string
          maintainer: string
        }
        deb: {
        artifactName: string
        packageCategory: string
        priority: string
        depends: string[]
        }
      }
    }

    expect(packageJson.scripts['package:linux:amd64']).toContain(
      'verify-target.mjs linux x64'
    )
    expect(packageJson.scripts['package:linux:amd64']).toContain(
      'electron-builder --linux deb --x64 --publish never'
    )
    expect(packageJson.build.linux).toEqual({
      target: [{ target: 'deb', arch: ['x64'] }],
      category: 'Development',
      icon: 'build/app-icon.png',
      executableName: 'dsh-desktop',
      maintainer: 'DataElement'
    })
    expect(packageJson.build.deb).toEqual({
      artifactName: 'dsh-desktop-linux-amd64.${ext}',
      packageCategory: 'devel',
      priority: 'optional',
      depends: [
        'libgtk-3-0',
        'libnotify4',
        'libnss3',
        'libxss1',
        'libxtst6',
        'xdg-utils',
        'libatspi2.0-0',
        'libuuid1',
        'libsecret-1-0',
        'libgbm1',
        'libasound2'
      ]
    })
  })

  it('packages a UOS-compatible Linux arm64 deb', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    expect(packageJson.scripts['package:linux:arm64']).toContain(
      'verify-target.mjs linux arm64'
    )
    expect(packageJson.scripts['package:linux:arm64']).toContain(
      'electron-builder --linux deb --arm64 --publish never'
    )
    expect(packageJson.scripts['package:linux:arm64']).toContain(
      "--config.deb.artifactName='dsh-desktop-linux-arm64.${ext}'"
    )
  })

  it('builds and uploads the UOS arm64 Debian package from GitHub Actions', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'uos-arm64-deb.yml'),
      'utf8'
    )

    expect(workflow).toContain('codex/uos-arm64-deb')
    expect(workflow).toContain('runs-on: ubuntu-24.04-arm')
    expect(workflow).toContain('--platform linux/arm64')
    expect(workflow).toContain('-f build/linux-arm64.Dockerfile')
    expect(workflow).toContain('name: dsh-desktop-linux-arm64')
    expect(workflow).toContain('path: dist-uos/dsh-desktop-linux-arm64.deb')
  })

  it('verifies Linux deb metadata, layout, and executable architecture', async () => {
    const verifier = await readFile(
      path.join(projectRoot, 'scripts', 'verify-linux-deb.sh'),
      'utf8'
    )

    expect(verifier).toContain('dpkg-deb -f "$deb_path" Architecture')
    expect(verifier).toContain('expected_arch="${2:-amd64}"')
    expect(verifier).toContain("amd64) elf_machine='Advanced Micro Devices X86-64'")
    expect(verifier).toContain("arm64) elf_machine='AArch64'")
    expect(verifier).toContain('if [ "$architecture" != "$expected_arch" ]')
    expect(verifier).toContain('usr/share/applications/dsh-desktop.desktop')
    expect(verifier).toContain('opt/DSH Desktop/dsh-desktop')
    expect(verifier).toContain('grep -F "$elf_machine"')
  })

  it.skipIf(process.platform === 'win32')('accepts a default amd64 deb through the verifier', async () => {
    await withVerifierFixture(async ({ run }) => {
      const result = await run()
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Verified Linux amd64 DEB')
    })
  })

  it.skipIf(process.platform === 'win32')('accepts an explicit arm64 deb through the verifier', async () => {
    await withVerifierFixture(async ({ run }) => {
      const result = await run('arm64', {
        FAKE_ARCH: 'arm64',
        FAKE_MACHINE: 'AArch64'
      })
      expect(result.status).toBe(0)
      expect(result.stdout).toContain('Verified Linux arm64 DEB')
    })
  })

  it.skipIf(process.platform === 'win32')('rejects a deb whose metadata architecture does not match', async () => {
    await withVerifierFixture(async ({ run }) => {
      const result = await run('arm64', { FAKE_ARCH: 'amd64' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("DEB architecture mismatch: expected 'arm64', got 'amd64'.")
    })
  })

  it.skipIf(process.platform === 'win32')('rejects a deb whose executable machine does not match', async () => {
    await withVerifierFixture(async ({ run }) => {
      const result = await run('arm64', {
        FAKE_ARCH: 'arm64',
        FAKE_MACHINE: 'Advanced Micro Devices X86-64'
      })
      expect(result.status).toBe(1)
      expect(result.stdout).toBe('')
    })
  })

  it.skipIf(process.platform === 'win32')('rejects unsupported architectures before package processing', async () => {
    await withVerifierFixture(async ({ run, markerPath }) => {
      const result = await run('riscv64')
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Unsupported Linux architecture: riscv64')
      await expect(readFile(markerPath, 'utf8')).rejects.toThrow()
    })
  })

  it('builds the Linux package against the Debian 10 compatibility baseline', async () => {
    const dockerfile = await readFile(
      path.join(projectRoot, 'build', 'linux-amd64.Dockerfile'),
      'utf8'
    )

    expect(dockerfile).toContain('FROM --platform=linux/amd64 debian:10-slim AS build')
    expect(dockerfile).toContain('ARG NODE_VERSION=22.20.0')
    expect(dockerfile).toContain('RUN npm ci')
    expect(dockerfile).toContain(
      'RUN npm test -- --exclude test/feishu-release-notes.test.ts && npm run typecheck'
    )
    expect(dockerfile).toContain('RUN npm run package:linux:amd64')
    expect(dockerfile).toContain('scripts/verify-linux-deb.sh')
    expect(dockerfile).toContain('apt-get install -y')
    expect(dockerfile).toContain('./dist/dsh-desktop-linux-amd64.deb')
    expect(dockerfile).toContain('runuser -u smoke -- xvfb-run')
    expect(dockerfile).toContain('"/opt/DSH Desktop/dsh-desktop" --no-sandbox')
  })

  it('builds the Linux arm64 package against the Debian 10 compatibility baseline', async () => {
    const dockerfile = await readFile(
      path.join(projectRoot, 'build', 'linux-arm64.Dockerfile'),
      'utf8'
    )

    expect(dockerfile).toContain('FROM --platform=linux/arm64 debian:10-slim AS build')
    expect(dockerfile).toContain('node-v${NODE_VERSION}-linux-arm64.tar.xz')
    expect(dockerfile).toContain('RUN npm run package:linux:arm64')
    expect(dockerfile).toContain(
      'scripts/verify-linux-deb.sh dist/dsh-desktop-linux-arm64.deb arm64'
    )
    expect(dockerfile).toContain('./dist/dsh-desktop-linux-arm64.deb')
    expect(dockerfile).toContain('runuser -u smoke -- xvfb-run')
    expect(dockerfile).toContain('"/opt/DSH Desktop/dsh-desktop" --no-sandbox')
  })

  it('keeps the package and lockfile versions aligned', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { version: string }
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as { version: string; packages: Record<string, { version?: string }> }

    expect(packageLock.version).toBe(packageJson.version)
    expect(packageLock.packages['']?.version).toBe(packageJson.version)
  })

  it('declares required DSH peer packages as production dependencies', async () => {
    const packageLock = JSON.parse(
      await readFile(path.join(projectRoot, 'package-lock.json'), 'utf8')
    ) as {
      packages: Record<string, { dev?: boolean; peer?: boolean }>
    }

    // A lock location is a path, so nested installs read as
    // `node_modules/<host>/node_modules/<name>`. Only the segment after the
    // last `node_modules/` names the package: without that, a third-party peer
    // that npm nested under a DSH package (rc.8 gives ui-trajectory its own
    // React 19) reads as a DSH package and trips this guard.
    const packageNameOf = (location: string): string =>
      location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)

    const peerOnlyRuntimePackages = Object.entries(packageLock.packages)
      .filter(
        ([location, metadata]) =>
          packageNameOf(location).startsWith('@deepseek-ai/') &&
          metadata.peer === true &&
          metadata.dev !== true
      )
      .map(([location]) => packageNameOf(location))

    expect(peerOnlyRuntimePackages).toEqual([])
  })

  it('uses stable platform-specific artifact names', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      build: {
        artifactName: string
        extraResources: Array<{ from: string; to: string }>
        win: { target: Array<{ target: string; arch: string[] }> }
        nsis: { artifactName: string; include: string }
        portable?: unknown
      }
    }

    expect(packageJson.build.artifactName).toBe('dsh-desktop-${os}-${arch}.${ext}')
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/app-icon.png',
      to: 'icon.png'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/splash.html',
      to: 'splash.html'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/dsh-loader.gif',
      to: 'dsh-loader.gif'
    })
    expect(packageJson.build.extraResources).toContainEqual({
      from: 'build/dsh-desktop.patch.yml',
      to: 'dsh-desktop.patch.yml'
    })
    expect(packageJson.build.nsis.artifactName).toBe(
      'dsh-desktop-windows-${arch}-setup.${ext}'
    )
    expect(packageJson.build.nsis.include).toBe('build/installer.nsh')
    expect(packageJson.build.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(packageJson.build.portable).toBeUndefined()
  })

  it('turns a selected Windows drive root into an application directory', async () => {
    const installer = await readFile(
      path.join(projectRoot, 'build', 'installer.nsh'),
      'utf8'
    )

    expect(installer).toContain('!define MUI_PAGE_CUSTOMFUNCTION_SHOW DshDirectoryPageShow')
    expect(installer).toContain('${NSD_OnChange} $DshDirectoryEdit DshDirectoryChanged')
    expect(installer).toContain('StrCpy $3 "$0\\${APP_FILENAME}"')
    expect(installer).toContain('StrCpy $3 "$0${APP_FILENAME}"')
    expect(installer).toContain('${NSD_SetText} $DshDirectoryEdit $3')
  })

  it('shows a packaged startup surface and pins the Electron directory picker surface', async () => {
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')
    const splash = await readFile(path.join(projectRoot, 'build', 'splash.html'), 'utf8')
    const patch = await readFile(
      path.join(projectRoot, 'build', 'dsh-desktop.patch.yml'),
      'utf8'
    )

    expect(main).toContain("desktopResourcePath('splash.html')")
    expect(main).toContain('await showSplash()')
    expect(splash).toContain('Starting DSH Desktop')
    expect(splash).toContain('src="dsh-loader.gif"')
    expect(splash).not.toContain('class="track"')
    expect(patch).not.toMatch(/id:\s*directory-picker/)
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-host-directory-picker-native'")
    expect(patch).not.toContain("name: '@deepseek-ai/dsh-client-ui-directory-picker-native'")
  })

  it('routes manual restarts through the active plugin recovery flow', async () => {
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')

    expect(main).toContain("if (failureRecoveryVisible) resolvePluginRecoveryAction('restart')")
    expect(main).toMatch(/case 'restart-harness':\s+await restartHarness\(\)/)
    expect(main).toContain('click: () => void restartHarness().catch(showUnexpectedError)')
    expect(main).toContain("} else if (action === 'restart') {")
  })

  it('replays frontend plugin failures that arrive during an active recovery', async () => {
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')

    expect(main).toContain("resolvePluginRecoveryAction('refresh')")
    expect(main).toContain('if (applyPendingFrontendEvidence()) continue')
    expect(main).toMatch(
      /if \(failureRecoveryVisible\) \{\s+queuePendingFrontendPluginRecovery\(message\)/
    )
    expect(main).toContain('queueMicrotask(() => {')
    expect(main).toContain('logs: [...rendererPluginFailureLogs]')
  })

  it('publishes update metadata for installed desktop builds', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as {
      dependencies: Record<string, string>
      build: {
        publish: Array<{ provider: string; url?: string; owner?: string; repo?: string }>
        win: { verifyUpdateCodeSignature: boolean }
      }
    }
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    expect(packageJson.dependencies['electron-updater']).toBeTruthy()
    expect(packageJson.build.publish).toEqual([
      { provider: 'generic', url: 'https://dshdesktop.com/updates/latest/' }
    ])
    expect(packageJson.build.win.verifyUpdateCodeSignature).toBe(false)
    for (const asset of [
      'latest-mac-arm64.yml',
      'latest-mac-x64.yml',
      'latest-mac.yml',
      'latest.yml',
      'dsh-desktop-mac-arm64.zip.blockmap',
      'dsh-desktop-mac-x64.zip.blockmap',
      'dsh-desktop-windows-x64-setup.exe.blockmap'
    ]) {
      expect(workflow).toContain(asset)
    }
    expect(workflow).toContain('merge-mac-update-metadata.mjs')
  })

  it('keeps builder jobs from attempting implicit tag publishing', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }

    for (const script of [
      'package:mac',
      'package:mac:arm64',
      'package:mac:x64',
      'package:win',
      'package:dev:mac:arm64',
      'package:dev:mac:x64',
      'package:dev:win'
    ]) {
      expect(packageJson.scripts[script]).toContain('--publish never')
    }
  })

  it('packages an isolated development channel from the current workspace', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    const developmentConfig = await readFile(
      path.join(projectRoot, 'electron-builder.dev.cjs'),
      'utf8'
    )
    const main = await readFile(path.join(projectRoot, 'src', 'main', 'index.ts'), 'utf8')

    expect(packageJson.scripts['package:dev:dir']).toContain('npm run build')
    expect(packageJson.scripts['package:dev:dir']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:mac:arm64']).toContain('verify-target.mjs darwin arm64')
    expect(packageJson.scripts['package:dev:mac:arm64']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:mac:x64']).toContain('verify-target.mjs darwin x64')
    expect(packageJson.scripts['package:dev:mac:x64']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:win']).toContain('verify-target.mjs win32 x64')
    expect(packageJson.scripts['package:dev:win']).toContain('electron-builder.dev.cjs')
    expect(packageJson.scripts['package:dev:win']).toContain('--publish never')
    expect(developmentConfig).toContain("appId: 'io.dsh.desktop.dev'")
    expect(developmentConfig).toContain("productName: 'DSH Desktop Dev'")
    expect(developmentConfig).toContain("output: 'dist-dev'")
    expect(developmentConfig).toContain("dshDesktopChannel: 'development'")
    expect(developmentConfig).toContain(
      "artifactName: 'dsh-desktop-dev-${os}-${arch}.${ext}'"
    )
    expect(developmentConfig).toContain(
      "artifactName: 'dsh-desktop-dev-windows-${arch}-setup.${ext}'"
    )
    expect(main).toContain("app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop-dev'))")
    expect(main).toContain("app.setPath('userData', join(app.getPath('appData'), 'dsh-desktop'))")
    expect(main).toContain('if (!developmentBuild)')
  })

  it('builds and publishes every supported platform', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    expect(workflow).toContain('runs-on: macos-15')
    expect(workflow).toContain('runs-on: macos-15-intel')
    expect(workflow).toContain('runs-on: windows-2022')
    expect(workflow).toContain('npm run package:dev:win')
    expect(workflow).toContain('Smoke test packaged Windows Harness')
    expect(workflow).toContain("$executable = 'dist-dev\\win-unpacked\\DSH Desktop Dev.exe'")
    expect(workflow).toContain('Packaged Windows Harness smoke test passed.')
    expect(workflow).toContain("Invoke-HarnessRpc 'workspace.create'")
    expect(workflow).toContain("Invoke-HarnessRpc 'session.create'")
    expect(workflow).toContain('Harness process exited after workspace and session creation.')
    expect(workflow).toContain('windows_prerelease_tag:')
    expect(workflow).toContain('Publish validated Windows development pre-release')
    expect(workflow).toContain('gh release create $env:PRERELEASE_TAG')
    expect(workflow).toContain('--prerelease')
    expect(workflow).toContain('name: windows-x64-dev')
    expect(workflow).toContain('dist-dev/dsh-desktop-dev-windows-x64-setup.exe')
    for (const asset of releaseAssets) expect(workflow).toContain(asset)
    expect(
      workflow.match(
        /npm version --no-git-tag-version --allow-same-version "\$\{\{ github\.ref_name \}\}"/g
      )
    ).toHaveLength(3)
  })

  it('signs and notarizes both macOS architectures on tag releases', async () => {
    const workflow = await readFile(
      path.join(projectRoot, '.github', 'workflows', 'release.yml'),
      'utf8'
    )

    for (const secret of [
      'DESKTOP_CSC_LINK',
      'DESKTOP_CSC_KEY_PASSWORD',
      'DESKTOP_APPLE_API_KEY',
      'DESKTOP_APPLE_API_KEY_ID',
      'DESKTOP_APPLE_API_ISSUER',
      'DESKTOP_APPLE_TEAM_ID'
    ]) {
      expect(workflow).toContain(`secrets.${secret}`)
    }
    expect(workflow.match(/Prepare macOS signing keychain/g)).toHaveLength(2)
    expect(workflow.match(/xcrun stapler validate/g)).toHaveLength(4)
    expect(workflow.match(/xcrun notarytool submit/g)).toHaveLength(2)
    expect(workflow.match(/CSC_IDENTITY_AUTO_DISCOVERY: 'false'/g)).toHaveLength(2)
    expect(workflow).not.toContain("CSC_LINK: ''")
    expect(workflow).toMatch(
      /macos-apple-silicon:\r?\n\s+name: macOS Apple Silicon\r?\n(?:[\s\S]*?)runs-on: macos-15\r?\n\s+steps:/
    )
    expect(workflow).toMatch(
      /macos-intel:\r?\n\s+name: macOS Intel\r?\n(?:[\s\S]*?)runs-on: macos-15-intel\r?\n\s+steps:/
    )
    expect(workflow).toMatch(
      /windows-x64:\r?\n\s+name: Windows x64\r?\n(?:[\s\S]*?)runs-on: windows-2022\r?\n\s+steps:/
    )
  })

  it('routes the published download through the official website', async () => {
    const readmes = await Promise.all(
      ['README.md', 'README.zh.md'].map((file) =>
        readFile(path.join(projectRoot, file), 'utf8')
      )
    )

    for (const readme of readmes) {
      expect(readme).toContain('https://www.dshdesktop.com/#download')
      expect(readme).not.toContain('| Platform | Package | Download |')
      expect(readme).not.toContain('| 平台 | 安装包 | 下载 |')
      expect(readme).not.toContain('Coming soon')
      expect(readme).not.toContain('即将发布')
      expect(readme).not.toContain('github.com/dataelement/dsh-desktop/releases')
      for (const asset of releaseAssets) {
        expect(readme).not.toContain(`releases/latest/download/${asset}`)
      }
    }
  })
})
