#!/usr/bin/env python3
"""Relocate the Nemotron 3 runtime into nemotron-dist/ for the release bundle.

scripts/setup-diarization.sh links libnemo_speech_asr against Homebrew's
sentencepiece and abseil. Users do not have those, so every non-system
dependency is copied next to the entry library and rewritten to @rpath with
@loader_path, then ad-hoc re-signed (install_name_tool invalidates signatures).
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / '.cache/nemotron'
DIST = ROOT / 'nemotron-dist'
ENTRY = 'libnemo_speech_asr_c.dylib'
SYSTEM = ('/usr/lib/', '/System/')


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def dependencies(path):
    lines = run('otool', '-L', str(path)).splitlines()[1:]
    deps = [line.strip().split(' (compatibility')[0] for line in lines]
    own_id = run('otool', '-D', str(path)).splitlines()[1:]
    return [dep for dep in deps if dep not in own_id and not dep.startswith(SYSTEM)]


def resolve(dep, loader):
    if dep.startswith('@rpath/') or dep.startswith('@loader_path/'):
        candidate = SOURCE / 'lib' / Path(dep).name
        if not candidate.exists():
            candidate = loader.parent / Path(dep).name
    else:
        candidate = Path(dep)
    if not candidate.exists():
        sys.exit(f'Missing dependency {dep} (needed by {loader.name})')
    return candidate.resolve()


def main():
    entry = SOURCE / 'lib' / ENTRY
    if not entry.exists():
        sys.exit('Build the runtime first: NEMOTRON_SKIP_MODEL=1 bash scripts/setup-diarization.sh')
    shutil.rmtree(DIST, ignore_errors=True)
    lib_dir = DIST / 'lib'
    lib_dir.mkdir(parents=True)
    # Copy the dependency closure under the names the loaders ask for.
    pending, copied = [(ENTRY, entry.resolve())], {}
    while pending:
        name, source = pending.pop()
        if name in copied:
            continue
        target = lib_dir / name
        shutil.copy2(source, target)
        target.chmod(0o755)
        copied[name] = [dep for dep in dependencies(source)]
        pending += [(Path(dep).name, resolve(dep, source)) for dep in copied[name]]
    for name, deps in copied.items():
        target = lib_dir / name
        args = ['install_name_tool', '-id', f'@rpath/{name}']
        for dep in deps:
            if not dep.startswith('@rpath/'):
                args += ['-change', dep, f'@rpath/{Path(dep).name}']
        run(*args, str(target))
        if '@loader_path' not in run('otool', '-l', str(target)):
            run('install_name_tool', '-add_rpath', '@loader_path', str(target))
        run('codesign', '--force', '--sign', '-', str(target))
    leaks = [f'{name}: {dep}' for name in copied for dep in dependencies(lib_dir / name)
             if not dep.startswith('@rpath/')]
    if leaks:
        sys.exit('Unrelocated dependencies:\n' + '\n'.join(leaks))
    if (SOURCE / 'share/licenses').exists():
        shutil.copytree(SOURCE / 'share/licenses', DIST / 'licenses')
    print(f'Bundled {len(copied)} libraries into {lib_dir.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
