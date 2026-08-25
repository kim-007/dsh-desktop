import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

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

  it('verifies Linux deb metadata, layout, and executable architecture', async () => {
    const verifier = await readFile(
      path.join(projectRoot, 'scripts', 'verify-linux-deb.sh'),
      'utf8'
    )

    expect(verifier).toContain('dpkg-deb -f "$deb_path" Architecture')
    expect(verifier).toContain("expected 'amd64'")
    expect(verifier).toContain('usr/share/applications/dsh-desktop.desktop')
    expect(verifier).toContain('opt/DSH Desktop/dsh-desktop')
    expect(verifier).toContain('Advanced Micro Devices X86-64')
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
