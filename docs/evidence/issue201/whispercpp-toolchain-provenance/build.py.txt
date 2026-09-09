#!/usr/bin/env python3

#   Copyright 2015 WebAssembly Community Group participants
#
#   Licensed under the Apache License, Version 2.0 (the "License");
#   you may not use this file except in compliance with the License.
#   You may obtain a copy of the License at
#
#       http://www.apache.org/licenses/LICENSE-2.0
#
#   Unless required by applicable law or agreed to in writing, software
#   distributed under the License is distributed on an "AS IS" BASIS,
#   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
#   See the License for the specific language governing permissions and
#   limitations under the License.

import argparse
import glob
import json
import multiprocessing
import os
import platform
import re
import shutil
import struct
import sys
import tarfile
import tempfile
import textwrap
import time
import traceback
import zipfile
import zlib
from datetime import UTC, datetime
from urllib.request import URLError, urlopen

import buildbot
import cloud
import host_toolchains
import proc
import testing
import work_dirs
from file_util import Chdir, Mkdir, Remove
from git_util import GitRevision, RevisionModifiesFile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)
NINJA_DIR = os.path.join(ROOT_DIR, 'third_party', 'ninja')
GCLOUD_DIR = os.path.join(ROOT_DIR, 'third_party', 'gcloud', 'bin')
# Python executable that will be used by emscripten subprocesses.
# For now we just use the running executable, but in the future we could use
# a different one (for the python binary in emsdk).
EMSDK_PYTHON = sys.executable

EMSCRIPTEN_CONFIG_TEMPLATE = 'emscripten_config'
RELEASE_DEPS_FILE = 'DEPS.tagged-release'

CLANG_GIT_REPO = 'https://github.com/llvm/llvm-project'

EMSDK_STORAGE_BASE = 'https://webassembly.storage.googleapis.com/emscripten-releases-builds/deps/'

# Update this number each time you want to create a clobber build.  If the
# clobber_version.txt file in the build dir doesn't match we remove ALL work
# dirs.  This works like a simpler version of chromium's landmine feature.
CLOBBER_BUILD_TAG = 67

options = None


def GetBuildDir(*args):
    return os.path.join(work_dirs.GetBuild(), *args)


def GetPrebuilt(*args):
    return os.path.join(work_dirs.GetPrebuilt(), *args)


def GetSrcDir(*args):
    return os.path.join(work_dirs.GetSync(), *args)


def GetInstallDir(*args):
    return os.path.join(work_dirs.GetInstall(), *args)


def GetTestDir(*args):
    return os.path.join(work_dirs.GetTest(), *args)


def GetTempDir(*args):
    return os.path.join(work_dirs.GetBuild(), 'temp', *args)


def GetLLVMSrcDir(*args):
    return GetSrcDir('llvm-project', *args)


def ApplyPatches(patch_dir, target_dir):
    if not os.path.isdir(patch_dir):
        return
    patches = sorted(glob.glob(os.path.join(patch_dir, '*.patch')))
    if not patches:
        return
    buildbot.Step('Apply patches from %s' % os.path.basename(patch_dir))
    for patch in patches:
        print('Applying patch: %s' % os.path.basename(patch))
        # If the patch is already applied, 'git apply' will fail.
        # We check first if the patch can be applied.
        # If it cannot be applied, it might already be applied.
        try:
            proc.check_call(['git', 'apply', '--check', patch], cwd=target_dir)
            proc.check_call(['git', 'apply', patch], cwd=target_dir)
        except proc.CalledProcessError:
            # If check failed, see if it is already applied.
            try:
                proc.check_call(['git', 'apply', '--reverse', '--check', patch],
                                cwd=target_dir)
                print('Patch %s already applied' % os.path.basename(patch))
            except proc.CalledProcessError:
                print('Patch %s failed to apply' % os.path.basename(patch))
                raise


def UnapplyPatches(target_dir):
    buildbot.Step('Cleanup patches from %s' % os.path.basename(target_dir))
    proc.check_call(['git', 'reset', '--hard', 'HEAD'], cwd=target_dir)
    proc.check_call(['git', 'clean', '-fd'], cwd=target_dir)


def IsWindows():
    return sys.platform == 'win32'


def IsLinux():
    return sys.platform.startswith('linux')


def IsArm64():
    return platform.machine() in {'aarch64', 'arm64'}


def IsMac():
    return sys.platform == 'darwin'


def GetCrossArch():
    if platform.machine() == 'x86_64':
        return 'aarch64' if IsLinux() else 'arm64'
    elif IsArm64():
        return 'x86_64'
    raise Exception('Unknown native build architecture')


def Executable(name):
    if IsWindows():
        # TODO: Remove this once we finish the transition to executable
        # launchers in emscripten.
        if os.path.exists(name + '.bat'):
            return name + '.bat'
        else:
            return name + '.exe'
    return name


def WindowsFSEscape(path):
    return os.path.normpath(path).replace('\\', '/')


# Use prebuilt Node.js because the buildbots don't have node preinstalled
# Keep in sync with node version used in emsdk.
NODE_VERSION = '24.19.0'
NODE_BASE_NAME = 'node-v' + NODE_VERSION + '-'


def NodePlatformName():
    if IsMac():
        return 'darwin-arm64' if IsArm64() else 'darwin-x64'
    elif IsWindows():
        return 'win-x64'
    elif IsLinux():
        return 'linux-arm64' if IsArm64() else 'linux-x64'


def NodeBinDir():
    node_subdir = NODE_BASE_NAME + NodePlatformName()
    if IsWindows():
        return GetPrebuilt(node_subdir)
    else:
        return GetPrebuilt(node_subdir, 'bin')


def NodeBin():
    return Executable(os.path.join(NodeBinDir(), 'node'))


def JavaHomeDir():
    assert IsMac(), 'only configured for macOS'
    arch = 'aarch64' if IsArm64() else 'x64'
    return GetPrebuilt(
        f'jdk-26_macos-{arch}_bin', 'jdk-26.0.1.jdk', 'Contents', 'Home')


def JavaPath():
    return os.path.join(JavaHomeDir(), 'bin')


def PrebuiltCMakePlatformName():
    return {
        'linux': 'linux',
        'linux2': 'linux',
        'darwin': 'macos',
        'win32': 'windows',
    }[sys.platform]


def PrebuiltCMakeArch():
    if IsMac():
        return 'universal'
    elif IsLinux() and IsArm64():
        return 'aarch64'
    else:
        return 'x86_64'


PREBUILT_CMAKE_VERSION = '3.31.11'
PREBUILT_CMAKE_BASE_NAME = 'cmake-%s-%s-%s' % (
    PREBUILT_CMAKE_VERSION, PrebuiltCMakePlatformName(), PrebuiltCMakeArch())


def PrebuiltCMakeDir(*args):
    return GetPrebuilt(PREBUILT_CMAKE_BASE_NAME, *args)


def PrebuiltCMakeBin():
    if IsMac():
        bin_dir = os.path.join('CMake.app', 'Contents', 'bin')
    else:
        bin_dir = 'bin'
    return PrebuiltCMakeDir(bin_dir, 'cmake')


def BuilderPlatformName():
    return {
        'linux': 'linux',
        'linux2': 'linux',
        'darwin': 'mac',
        'win32': 'windows',
    }[sys.platform]


# Known failures.
RUN_LLVM_TESTSUITE_FAILURES = [
    os.path.join(SCRIPT_DIR, 'test', 'llvmtest_known_failures.txt'),
]

# Optimization levels
BARE_TEST_OPT_FLAGS = ['O0', 'O2']
EMSCRIPTEN_TEST_OPT_FLAGS = ['O0', 'O3']

NPROC = multiprocessing.cpu_count()

if IsMac():
    # Experimental temp fix for crbug.com/829034 stdout write sometimes fails
    from fcntl import F_GETFL, F_SETFL, fcntl
    fd = sys.stdout.fileno()
    flags = fcntl(fd, F_GETFL)
    fcntl(fd, F_SETFL, flags & ~os.O_NONBLOCK)

g_should_use_lto = None


def ShouldUseLTO():
    if options.use_lto == 'auto':
        # Avoid shelling out to git (via RevisionModifiesFile) more than once.
        global g_should_use_lto
        if g_should_use_lto is None:
            g_should_use_lto = RevisionModifiesFile(
                GetSrcDir(RELEASE_DEPS_FILE))
        return g_should_use_lto
    return options.use_lto == 'true'


def CopyBinaryToArchive(binary, prefix=''):
    """All binaries are archived in the same tar file."""
    install_bin = GetInstallDir(prefix, 'bin')
    print('Copying binary %s to archive %s' % (binary, install_bin))
    Mkdir(install_bin)
    shutil.copy2(binary, install_bin)


def Archive(directory, print_content=False):
    """Create an archive file from directory."""
    # Use the format "native" to the platform
    if IsWindows():
        archive = Zip(directory, print_content)
    else:
        archive = Tar(directory, print_content)
    print('Archive created: %s [%s]' % (archive, os.path.getsize(archive)))
    return archive


def Tar(directory, print_content=False):
    assert os.path.isdir(directory), 'Must tar a directory to avoid tarbombs'
    up_directory, basename = os.path.split(directory)
    tar = os.path.join(up_directory, basename + '.tar.xz')
    Remove(tar)
    if print_content:
        proc.check_call(
            ['find', basename, '-type', 'f', '-exec', 'ls', '-lhS', '{}', '+'],
            cwd=up_directory)
    # Where possible use `--use-compress-program` rather than just `J` so that
    # we can pass extra arguments to the xz compressor.  In this case `-T0`
    # tell is to use all the available cores during compression.
    if buildbot.IsUploadingBot():
        if IsMac():
            cmd = ['tar', 'cJf', tar, basename]
        else:
            cmd = ['tar', '--use-compress-program', 'xz -T0', '-cf', tar, basename]
    else:
        # If we are not going to upload, use a faster compression method (i.e. none)
        cmd = ['tar', 'cf', tar, basename]
    proc.check_call(cmd, cwd=up_directory)
    proc.check_call(['ls', '-lh', tar], cwd=up_directory)
    return tar


def Zip(directory, print_content=False):
    assert os.path.isdir(directory), 'Must be a directory'
    dirname, basename = os.path.split(directory)
    archive = os.path.join(dirname, basename + '.zip')
    print('Creating zip archive', archive)
    compression = (zipfile.ZIP_DEFLATED if buildbot.IsUploadingBot()
                   else zipfile.ZIP_STORED)
    with zipfile.ZipFile(archive, 'w', compression) as z:
        for root, _dirs, files in os.walk(directory):
            for name in files:
                fs_path = os.path.join(root, name)
                zip_path = os.path.relpath(fs_path, os.path.dirname(directory))
                if print_content:
                    print('Adding', fs_path)
                z.write(fs_path, zip_path)
    print('Size:', os.stat(archive).st_size)
    return archive


def UploadArchive(name, archive):
    """Archive the tar/zip file with the given name and the build number."""

    def extensions(path):
        """Return all filename extensions (e.g. .tar.xz or .tgz)."""
        root, ext = os.path.splitext(path)
        return ext if root == path else extensions(root) + ext

    remote_name = name + extensions(archive)
    if not buildbot.IsUploadingBot():
        print('Not an uploading bot: remote_name ' + remote_name)
        return
    buildbot.Link(
        'download',
        cloud.Upload(archive, cloud.GetArchivePath(remote_name)))


def FilterTargets(to_run, all_targets):
    for r in to_run:
        found = False
        for t in all_targets:
            if t.name == r:
                found = True
                yield t
        if not found:
            pretty_targets = TextWrapNameList(prefix='', items=all_targets)
            raise Exception(f'{r} not found in target list:\n{pretty_targets}')


class Source:
    """Metadata about a sync-able source repo on the waterfall."""

    def __init__(self, name, src_dir=None, custom_sync=None):
        self.name = name
        self.src_dir = src_dir
        self.custom_sync = custom_sync

    def Sync(self):
        assert self.custom_sync
        self.custom_sync(self.name, self.src_dir)


def SyncToolchain(_name, src_dir):
    if IsWindows():
        host_toolchains.SyncWinToolchain()
    else:
        host_toolchains.SyncPrebuiltClang(src_dir)
        cc = host_toolchains.GetPrebuiltClang('clang')
        cxx = host_toolchains.GetPrebuiltClang('clang++')
        assert os.path.isfile(cc), 'Expect clang at %s' % cc
        assert os.path.isfile(cxx), 'Expect clang++ at %s' % cxx


def SyncArchive(out_dir, name, url, create_out_dir=False):
    """Download and extract an archive (zip, tar.gz or tar.xz) file from a URL.

    The extraction happens in the prebuilt dir. If create_out_dir is True,
    out_dir will be created and the archive will be extracted inside. Otherwise
    the archive is expected to contain a top-level directory with all the
    files; this is expected to be 'out_dir', so if 'out_dir' already exists
    then the download will be skipped.
    """
    stamp_file = os.path.join(out_dir, 'stamp.txt')
    if os.path.isdir(out_dir):
        if os.path.isfile(stamp_file):
            with open(stamp_file) as f:
                stamp_url = f.read().strip()
            if stamp_url == url:
                print('%s directory already exists' % name)
                return
        print('%s directory exists but is not up-to-date' % name)
        Remove(out_dir)
    print('Downloading %s from %s' % (name, url))

    if create_out_dir:
        os.makedirs(out_dir)
        work_dir = out_dir
    else:
        work_dir = os.path.dirname(out_dir)

    try:
        f = urlopen(url)
        print('URL: %s' % f.geturl())
        print('Info: %s' % f.info())
        with tempfile.NamedTemporaryFile() as t:
            t.write(f.read())
            t.flush()
            t.seek(0)
            print('Extracting into %s' % work_dir)
            ext = os.path.splitext(url)[-1]
            if ext == '.zip':
                with zipfile.ZipFile(t, 'r') as zip:
                    zip.extractall(path=work_dir)
            elif ext == '.xz':
                proc.check_call(['tar', '-xf', t.name], cwd=work_dir)
            else:
                tarfile.open(fileobj=t).extractall(path=work_dir)
    except URLError as e:
        print('Error downloading %s: %s' % (url, e))
        raise

    with open(stamp_file, 'w') as f:
        f.write(url + '\n')


def SyncPrebuiltCMake(_name, _src_dir):
    extension = '.zip' if IsWindows() else '.tar.gz'
    url = EMSDK_STORAGE_BASE + PREBUILT_CMAKE_BASE_NAME + extension
    SyncArchive(PrebuiltCMakeDir(), 'cmake', url)


def SyncPrebuiltNodeJS(name, _src_dir):
    extension = {
        'darwin': 'tar.gz',
        'linux': 'tar.xz',
        'win32': 'zip',
    }[sys.platform]
    out_dir = GetPrebuilt(NODE_BASE_NAME + NodePlatformName())
    tarball = NODE_BASE_NAME + NodePlatformName() + '.' + extension
    node_url = EMSDK_STORAGE_BASE + tarball
    return SyncArchive(out_dir, name, node_url)


def LinuxSysroot(arch):
    distro = 'stretch_amd64_v2' if arch == 'x86_64' else 'bullseye_arm64'
    return 'sysroot_debian_' + distro


def SyncLinuxSysroots(name, _src_dir):
    if not (IsLinux() and host_toolchains.ShouldUseSysroot()):
        return
    for arch in ('x86_64', 'arm64'):
        SyncArchive(GetPrebuilt(LinuxSysroot(arch)),
                    name,
                    EMSDK_STORAGE_BASE + LinuxSysroot(arch) + '.tar.xz',
                    create_out_dir=True)


def SyncReleaseDeps(_name, _src_dir):
    if not ShouldUseLTO():
        print('ShouldUseLTO is false, skipping release DEPS')
        return
    shutil.copy2(GetSrcDir(RELEASE_DEPS_FILE), GetSrcDir('DEPS'))
    proc.check_call(['gclient', 'sync'], cwd=GetSrcDir())


def NoSync(*args):
    pass


def AllSources():
    return [
        Source('host-toolchain', work_dirs.GetV8(), custom_sync=SyncToolchain),
        Source('cmake', custom_sync=SyncPrebuiltCMake),
        Source('nodejs', custom_sync=SyncPrebuiltNodeJS),
        Source('sysroot', custom_sync=SyncLinuxSysroots),
        Source('deps', custom_sync=SyncReleaseDeps),
    ]


def RemoveIfBot(work_dir):
    if buildbot.IsBot():
        Remove(work_dir)


def Clobber():
    # Don't automatically clobber non-bot (local) work directories
    if not buildbot.IsBot() and not options.clobber:
        return

    clobber = options.clobber or buildbot.ShouldClobber()
    clobber_file = GetBuildDir('clobber_version.txt')
    if not clobber:
        if not os.path.exists(clobber_file):
            print('Clobber file %s does not exist.' % clobber_file)
            clobber = True
        else:
            existing_tag = int(open(clobber_file).read().strip())
            if existing_tag != CLOBBER_BUILD_TAG:
                print('Clobber file %s has tag %s.' %
                      (clobber_file, existing_tag))
                clobber = True

    if not clobber:
        return

    buildbot.Step('Clobbering work dir')
    work_dir = GetBuildDir()
    RemoveIfBot(work_dir)
    Mkdir(work_dir)
    with open(clobber_file, 'w') as f:
        f.write('%s\n' % CLOBBER_BUILD_TAG)


def SyncRepos(sync_targets):
    if not sync_targets:
        return
    buildbot.Step('Sync Repos')
    for repo in FilterTargets(sync_targets, AllSources()):
        repo.Sync()


# Build rules

def MaybeOverrideCMakeCompiler():
    if not host_toolchains.ShouldForceHostClang():
        if IsLinux() and IsArm64():
            return [
                '-DCMAKE_C_COMPILER=clang',
                '-DCMAKE_CXX_COMPILER=clang++',
            ]
        else:
            return []
    cc = 'clang-cl' if IsWindows() else 'clang'
    cxx = 'clang-cl' if IsWindows() else 'clang++'
    tools = [
        '-DCMAKE_C_COMPILER=' + Executable(
            host_toolchains.GetPrebuiltClang(cc)),
        '-DCMAKE_CXX_COMPILER=' + Executable(
            host_toolchains.GetPrebuiltClang(cxx)),
    ]
    # We need to use tools that work with LTO (i.e. they understand bitcode
    # when linking and creating archives).
    if IsWindows():
        tools.append('-DCMAKE_LINKER=' +
                     Executable(host_toolchains.GetPrebuiltClang('lld-link')))
        tools.append('-DCMAKE_AR=' +
                     host_toolchains.GetPrebuiltClang('lib.bat'))
    elif IsMac():
        tools.append('-DCMAKE_AR=' +
                     host_toolchains.GetPrebuiltClang('llvm-ar'))
        tools.append('-DCMAKE_RANLIB=' +
                     host_toolchains.GetPrebuiltClang('llvm-ranlib'))
        # LLVM's CMake wants to use libtool isntead of llvm-ar, but the Chrome
        # clang package doesn't have libtool. If we set CMAKE_LIBTOOL empty, it
        # will fall back to the default.
        tools.append('-DCMAKE_LIBTOOL=')
    return tools


def CMakeCommandBase():
    command = [PrebuiltCMakeBin(), '-G', 'Ninja']
    # Python's location could change, so always update CMake's cache
    command.extend(['-DPython3_EXECUTABLE=' + sys.executable,
                    '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
                    '-DCMAKE_BUILD_TYPE=Release'])
    if IsMac():
        # Target MacOS Mojave (11). Keep this in sync with emsdk.py
        command.append('-DCMAKE_OSX_DEPLOYMENT_TARGET=11')
    elif IsWindows():
        # CMake's usual logic fails to find LUCI's git on Windows
        git_exe = proc.Which('git')
        command.append('-DGIT_EXECUTABLE=%s' % git_exe)
        # Workaround for cmcldeps bug with forward slashes on Windows.
        # TODO: remove when this issue is fixed and we upgrade CMake.
        command.append('-DCMAKE_NINJA_CMCLDEPS_RC=OFF')
    return command


def CMakeCommandNative(args, build_dir, is_cross=False, filter_out_stdlib=False):  # noqa: C901
    command = CMakeCommandBase()
    command.append('-DCMAKE_INSTALL_PREFIX=%s' % GetInstallDir())

    # https://blog.llvm.org/2019/11/deterministic-builds-with-clang-and-lld.html:
    # Pass -no-canonical-prefixes to make clang use relative paths to refer to
    # compiler internal headers.
    cflags = '-no-canonical-prefixes'
    cxxflags = '-no-canonical-prefixes'
    arch = GetCrossArch() if is_cross else platform.machine()

    if host_toolchains.ShouldUseSysroot():
        if IsLinux():
            command.append('-DCMAKE_SYSROOT=%s' % GetPrebuilt(LinuxSysroot(arch)))
            if is_cross:
                command.append('-DCMAKE_SYSTEM_PROCESSOR=aarch64')
                command.append('-DCMAKE_SYSTEM_NAME=Linux')
                cflags += ' --target=aarch64-linux-gnu'
                cxxflags += ' --target=aarch64-linux-gnu'
        elif IsMac():
            # Get XCode SDK path.
            xcode_sdk_path = proc.check_output(['xcrun',
                                                '--show-sdk-path']).strip()
            # Create relpath symlink if it doesn't exist.
            # If it does exist, but points to a different location, update it.
            symlink_path = os.path.join(build_dir, 'xcode_sdk')
            if os.path.lexists(
                symlink_path) and os.readlink(symlink_path) != xcode_sdk_path:
                os.remove(symlink_path)
            if not os.path.exists(symlink_path):
                os.symlink(xcode_sdk_path, symlink_path)
            command.append(f'-DCMAKE_OSX_SYSROOT={symlink_path}')
            command.append(f'-DCMAKE_SYSROOT={symlink_path}')
            # Use an explicit triple for correct cross-compiles with reclient
            cflags += f' --target={arch}-apple-darwin'
            cxxflags += f' --target={arch}-apple-darwin'

    if UseLocalLibCXX() and not filter_out_stdlib:
        inc = LibCXXTempInstall('include', 'c++', 'v1')
        cxxflags = f'-stdlib++-isystem{inc} {cxxflags}'
        lib = LibCXXTempInstall('lib')
        command.append(f'-DCMAKE_EXE_LINKER_FLAGS=-L{lib} -stdlib=libc++')
        command.append(f'-DCMAKE_SHARED_LINKER_FLAGS=-L{lib} -stdlib=libc++')
        command.append(f'-DCMAKE_MODULE_LINKER_FLAGS=-L{lib} -stdlib=libc++')
    # On Windows  C(++) FLAGS are set with C(XX)FLAGS environment variables in BuildEnv function
    if not IsWindows():
        command.append(f'-DCMAKE_C_FLAGS={cflags}')
        command.append(f'-DCMAKE_CXX_FLAGS={cxxflags}')

    if IsMac():
        command.append(f'-DCMAKE_OSX_ARCHITECTURES={arch}')

    command.extend(MaybeOverrideCMakeCompiler())

    if host_toolchains.ShouldForceHostClang():
        # Goma and Reclient don't have the "default" SDK compilers in its cache, so only
        # use them when using our prebuilt Clang.
        command.extend(host_toolchains.CMakeLauncherFlags(host_toolchains.GetHostPlatform()))
    command.extend(args)
    # On Windows, CMake chokes on paths containing backslashes that come from
    # the command line. Probably they just need to be escaped, but using '/'
    # instead is easier and works just as well.
    return [WindowsFSEscape(arg) for arg in command]


def CleanLLVMInstall():
    # The following aren't useful for now, and take up space.
    # DLLs are in bin/ on Windows but in lib/ on posix.
    for unneeded_tool in ('clang-check', 'clang-cl', 'clang-cpp',
                          'clang-extdef-mapping', 'clang-format',
                          'clang-func-mapping', 'clang-import-test',
                          'clang-linker-wrapper', 'clang-offload-bundler',
                          'clang-offload-packager', 'clang-refactor',
                          'clang-rename', 'clang-repl',
                          'diagtool', 'git-clang-format', 'hmaptool', 'ld.lld',
                          'ld64.lld', 'ld64.lld.darwinnew', 'ld64.lld.darwinold',
                          'lld-link', 'libclang.dll', 'llvm-ml', 'llvm-ml64',
                          'llvm-lib', 'llvm-pdbutil', 'llvm-rc',
                          # From clang-tools-extra
                          'clang-apply-replacements', 'clang-change-namespace',
                          'clang-doc', 'clang-include-cleaner', 'clang-include-fixer',
                          'clang-move', 'clang-query', 'clang-reorder-fields',
                          'clang-tidy', 'find-all-symbols', 'modularize',
                          'pp-trace', 'run-clang-tidy'):
        Remove(GetInstallDir('bin', Executable(unneeded_tool)))

    for lib in ['libclang.%s' for suffix in ('so.*', 'dylib')]:
        Remove(GetInstallDir('lib', lib))


def CopyLLVMTools(build_dir):
    # The following are useful, LLVM_INSTALL_TOOLCHAIN_ONLY did away with them.
    extra_bins = map(Executable, [
        'llvm-dwarfdump', 'llvm-dwp', 'llvm-nm', 'llvm-objdump', 'llvm-readobj',
        'llvm-size',
    ])
    for p in [
            glob.glob(os.path.join(build_dir, 'bin', b)) for b in extra_bins
    ]:
        for e in p:
            CopyBinaryToArchive(os.path.join(build_dir, 'bin', e))


def BuildEnv(build_dir, bin_subdir=False,
             runtime='Release'):
    if host_toolchains.UsingReclient():
        host_toolchains.SetReclientEnv(host_toolchains.GetHostPlatform())
    if IsMac():
        # We need a ranlib that understands bitcode, but llvm-ranlib is not
        # included in Chrome's packaging. But ranlib is just ar by another name
        ranlib = host_toolchains.GetPrebuiltClang('llvm-ranlib')
        if not os.path.exists(ranlib):
            os.symlink(host_toolchains.GetPrebuiltClang('llvm-ar'), ranlib)
        return None
    if not IsWindows():
        return None
    cc_env = host_toolchains.SetUpVSEnv(build_dir)
    # This value matches the version of cl.exe currently used by the bots, but
    # it needs to be made explicit in order to run on Goma
    # (crbug.com/1292405). This will need to be updated when LLVM or another of
    # our projects requires a newer MSVC version.
    # Flags need to be injected via the env (rather than on the CMake command
    # line) so they add to rather than overriding the default flags.
    cc_env['CXXFLAGS'] = cc_env['CFLAGS'] = '-fmsc-version=1929'
    bin_dir = build_dir if not bin_subdir else os.path.join(build_dir, 'bin')
    Mkdir(bin_dir)
    assert runtime in {'Release', 'Debug'}
    return cc_env


def LLVM(build_dir, is_cross=False):  # noqa: C901
    buildbot.Step('LLVM')
    Mkdir(build_dir)
    cc_env = BuildEnv(build_dir, bin_subdir=True)
    build_dylib = 'ON'
    if IsWindows() or ShouldUseLTO() or options.link_static:
        build_dylib = 'OFF'

    # We configure LLVM to support the host architecture as well as
    # WebAssembly.  However, when we are cross compiling the host
    # architecture is different the build architecture.
    host_arch = 'Native'
    if is_cross:
        if platform.machine() == 'x86_64':
            host_arch = 'AArch64'
        else:
            host_arch = 'X86'

    cmake_flags = [
        '-DLLVM_ENABLE_LIBXML2=OFF',
        '-DLLVM_ENABLE_ZSTD=OFF',
        '-DLLVM_INCLUDE_EXAMPLES=OFF',
        '-DLLVM_BUILD_LLVM_DYLIB=%s' % build_dylib,
        '-DLLVM_LINK_LLVM_DYLIB=%s' % build_dylib,
        '-DCLANG_LINK_CLANG_DYLIB=%s' % build_dylib,
        '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
        '-DLLVM_ENABLE_BINDINGS=OFF',
        # Our mac bot's toolchain's ld64 is too old for trunk libLTO.
        '-DLLVM_TOOL_LTO_BUILD=OFF',
        '-DLLVM_INSTALL_TOOLCHAIN_ONLY=ON',
        '-DLLVM_TARGETS_TO_BUILD=%s;WebAssembly' % host_arch,
        '-DLLVM_ENABLE_PROJECTS=lld;clang;clang-tools-extra',
        # linking libtinfo dynamically causes problems on some linuxes,
        # https://github.com/emscripten-core/emsdk/issues/252
        '-DLLVM_ENABLE_TERMINFO=%d' % int(not IsLinux()),
        # LLVM's PCH support is new and currently seems to break reclient.
        '-DCMAKE_DISABLE_PRECOMPILE_HEADERS=ON',
        '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
        '-DCLANG_ENABLE_ARCMT=OFF',
        '-DCLANG_ENABLE_STATIC_ANALYZER=OFF',
        '-DCLANG_REPOSITORY_STRING=%s' % CLANG_GIT_REPO,
        '-DLLVM_USE_LINKER=%s' % options.llvm_linker,
    ]
    if UseStaticLibCXX():
        cmake_flags += ['-DLLVM_STATIC_LINK_CXX_STDLIB=ON']

    ninja_targets = ('all', 'install')

    if ShouldUseLTO():
        targets = ['clang', 'lld', 'llvm-ar', 'llvm-addr2line', 'llvm-cov',
                   'llvm-cxxfilt', 'llvm-dwarfdump', 'llvm-dwp', 'llvm-nm',
                   'llvm-objcopy', 'llvm-objdump', 'llvm-profdata', 'llvm-ranlib',
                   'llvm-readobj', 'llvm-size', 'llvm-strings',
                   'llvm-strip', 'llvm-symbolizer', 'clang-resource-headers',
                   'clang-scan-deps', 'clangd']
        ninja_targets = ('distribution', 'install-distribution')
        cmake_flags.extend(['-DLLVM_ENABLE_ASSERTIONS=OFF',
                            '-DLLVM_INCLUDE_TESTS=OFF',
                            '-DLLVM_TOOLCHAIN_TOOLS=' + ';'.join(targets),
                            '-DLLVM_DISTRIBUTION_COMPONENTS=' + ';'.join(targets),
                            '-DLLVM_ENABLE_LTO=Thin'])

    else:
        cmake_flags.extend(['-DLLVM_ENABLE_ASSERTIONS=ON'])

    if is_cross:
        # Cross builds need a native version of the tablegen tools to
        # run on the build machine. These can be built in a separate
        # "stage 1" build, but since our bots always build the full
        # toolchain as native before they build the cross toolchain,
        # we can just use tablegen from its build dir.
        native_build_dir = GetBuildDir('llvm-out')
        cmake_flags.append('-DLLVM_NATIVE_TOOL_DIR=' +
                           os.path.join(native_build_dir, 'bin'))

    cmake_cmd = CMakeCommandNative(
        [GetLLVMSrcDir('llvm')] + cmake_flags,
        build_dir,
        is_cross=is_cross)

    proc.check_call(cmake_cmd, cwd=build_dir, env=cc_env)

    # Copy the libc++ library to the build dir so that tablegen will run
    for suffix in ('2.dylib', 'so.2'):
        dylib = GetInstallDir('lib', f'libc++.{suffix}')
        if os.path.isfile(dylib):
            shutil.copy(dylib, os.path.join(build_dir, 'lib'))

    jobs = host_toolchains.NinjaJobs()
    proc.check_call(['ninja', '-v', ninja_targets[0]] + jobs,
                    cwd=build_dir, env=cc_env)
    proc.check_call(['ninja', ninja_targets[1]] + jobs,
                    cwd=build_dir, env=cc_env)

    CleanLLVMInstall()
    CopyLLVMTools(build_dir)
    install_bin = GetInstallDir('bin')
    for target in ('clang', 'clang++'):
        for prefix in 'wasm32-', 'wasm32-wasi-':
            link = os.path.join(install_bin, prefix + target)
            if not IsWindows():
                if not os.path.islink(Executable(link)):
                    os.symlink(Executable(target), Executable(link))
            else:
                # Windows has no symlinks (at least not from python). Also
                # clang won't work as a native compiler anyway, so just install
                # it as wasm32-wasi-clang
                shutil.copy2(Executable(os.path.join(install_bin, target)),
                             Executable(link))

    # LTO builds clobber their working directories after build to avoid
    # incremental build problems. But we saved native_build_dir for the cross
    # build, so clobber it now.
    if is_cross and ShouldUseLTO():
        RemoveIfBot(native_build_dir)


def LLVMTestDepends():
    buildbot.Step('LLVM Test Dependencies')
    build_dir = GetBuildDir('llvm-out')
    proc.check_call(['ninja', '-v', 'test-depends'] +
                    host_toolchains.NinjaJobs(),
                    cwd=build_dir,
                    env=BuildEnv(build_dir, bin_subdir=True))


def TestLLVMRegression():
    build_dir = GetBuildDir('llvm-out')
    cc_env = BuildEnv(build_dir, bin_subdir=True)
    if not os.path.isdir(build_dir):
        print('LLVM Build dir %s does not exist' % build_dir)
        buildbot.Fail()
        return

    def RunWithUnixUtils(cmd, **kwargs):
        if IsWindows():
            return proc.check_call(['git', 'bash'] + cmd, **kwargs)
        else:
            return proc.check_call(cmd, **kwargs)

    try:
        buildbot.Step('LLVM regression tests')
        RunWithUnixUtils(['ninja', 'check-all'], cwd=build_dir, env=cc_env)
    except proc.CalledProcessError:
        buildbot.FailUnless(IsWindows)


def UseLocalLibCXX():
    # Use our own libc++ to get around the Linux sysroot's very old
    # libstdc++. Also use it on mac.
    return not IsWindows() and host_toolchains.ShouldUseSysroot()


def LibCXXTempInstall(*args):
    return GetTempDir('libcxx-install', *args)


def UseStaticLibCXX():
    return UseLocalLibCXX() and (ShouldUseLTO() or options.link_static)


def LibCXX(build_dir, is_cross=False):
    buildbot.Step('libcxx')
    Remove(LibCXXTempInstall())
    Mkdir(build_dir)

    # We include either the shared library or the static library. The shared
    # version is used for the non-release builds to save space. However as an
    # extra special weird case, the LLVM regression test version (which does not
    # use LTO) needs to use static linking but also needs to be PIC because of the
    # dynamic loading tests.
    cmake_on = {False: 'OFF', True: 'ON'}
    should_use_static = UseStaticLibCXX()

    BuildEnv(build_dir)
    cmd = CMakeCommandNative(
        [GetLLVMSrcDir('runtimes'),
         '-DLLVM_ENABLE_RUNTIMES=libcxx;libcxxabi',
         # ABI version 2 gives some libc++ improvements, but the real reason is
         # to avoid any possibility of accidentally depending on system libc++
         '-DLIBCXX_ABI_VERSION=2',
         '-DLIBCXX_HAS_ATOMIC_LIB=OFF',
         f'-DLIBCXX_ENABLE_SHARED={cmake_on[not should_use_static]}',
         '-DLIBCXX_INCLUDE_TESTS=OFF',
         '-DLIBCXXABI_ENABLE_SHARED=OFF',
         '-DLIBCXXABI_INCLUDE_TESTS=OFF',
         '-DLIBCXXABI_USE_LLVM_UNWINDER=OFF',
         '-DLIBCXX_ENABLE_STATIC_ABI_LIBRARY=ON',
         f'-DLIBCXX_INSTALL_STATIC_LIBRARY={cmake_on[should_use_static]}',
         f'-DLIBCXXABI_INSTALL_STATIC_LIBRARY={cmake_on[should_use_static]}',
         f'-DCMAKE_POSITION_INDEPENDENT_CODE={cmake_on[not ShouldUseLTO()]}',
         f'-DCMAKE_INSTALL_PREFIX={LibCXXTempInstall()}',
         ], build_dir,
         is_cross=is_cross,
         # Filter out the stdlib flags because we are bootstrapping stdlib
         filter_out_stdlib=True)
    if IsMac():
        cmd.append('-DLIBCXX_USE_COMPILER_RT=ON')
    proc.check_call(cmd, cwd=build_dir)
    proc.check_call(['ninja', '-v', 'cxx', 'cxxabi'] + host_toolchains.NinjaJobs(),
                    cwd=build_dir)
    proc.check_call(['ninja', 'install-cxx', 'install-cxxabi'], cwd=build_dir)
    # Copy (and overwrite) the runtime libraries to the install dir
    Mkdir(GetInstallDir('lib'))
    for filename in os.listdir(LibCXXTempInstall('lib')):
        src = os.path.join(LibCXXTempInstall('lib'), filename)
        print(f'Copying {src} to {GetInstallDir("lib")}')
        shutil.copy2(src, GetInstallDir('lib'))


def Binaryen(build_dir, is_cross=False):
    buildbot.Step('binaryen')
    Mkdir(build_dir)
    # Currently it's a bad idea to do a non-asserts build of Binaryen
    cc_env = BuildEnv(build_dir, bin_subdir=True, runtime='Debug')

    cmake_command = CMakeCommandNative(
        [GetSrcDir('binaryen')], build_dir, is_cross=is_cross)
    cmake_command.extend(['-DINSTALL_LIBS=OFF', '-DBUILD_TESTS=OFF'])
    if ShouldUseLTO():
        cmake_command.append('-DBUILD_SHARED_LIBS=OFF')
        cmake_command.append('-DBYN_ENABLE_LTO=ON')
    if IsLinux():
        cmake_command.append('-DBUILD_MIMALLOC=ON')

    proc.check_call(cmake_command, cwd=build_dir, env=cc_env)
    proc.check_call(['ninja', '-v'] + host_toolchains.NinjaJobs(),
                    cwd=build_dir, env=cc_env)
    proc.check_call(['ninja', 'install'], cwd=build_dir, env=cc_env)


def InstallEmscripten(is_cross):
    em_install_dir = GetInstallDir('emscripten')
    print('Installing emscripten into %s' % em_install_dir)

    if is_cross:
        # For cross builds we just need to re-run `npm install` with the
        # correct architecture.
        proc.check_call(['npm', 'ci', '--verbose', '--cpu', GetCrossArch()], cwd=em_install_dir)

        # We expect the installation to already have been completed by the
        # native build.
        installed_libdir = GetInstallDir('emscripten/cache/sysroot/lib/wasm32-emscripten')
        libc = os.path.join(installed_libdir, 'libc.a')
        assert os.path.isfile(libc), libc
    else:
        Remove(em_install_dir)
        em_src_dir = GetSrcDir('emscripten')
        proc.check_call([os.path.join(em_src_dir, 'bootstrap.py')])
        proc.check_call([os.path.join('tools', 'install.py'), em_install_dir],
                        cwd=em_src_dir)


def Emscripten(is_cross=False):
    # Build the windows pylauncher executable.  We do this before the install
    # step to be sure we use the freshly-built executable rather than the
    # check-in one.
    pylauncher_dir = GetSrcDir('emscripten', 'tools', 'pylauncher')
    if IsWindows():
        # Remove any previously-created launcher scripts that are otherwise
        # git-ignored.
        proc.check_call(['git', 'clean', '-fx', '*.bat', '*.exe', '*.ps1'],
                        cwd=GetSrcDir('emscripten'))
        exe = os.path.join(pylauncher_dir, 'pylauncher.exe')
        os.remove(exe)
        cc_env = host_toolchains.SetUpVSEnv(pylauncher_dir)
        proc.check_call([os.path.join(pylauncher_dir, 'build.bat')], cwd=pylauncher_dir, env=cc_env)
        assert os.path.exists(exe)

    try:
        InstallEmscripten(is_cross)
    finally:
        if IsWindows():
            # Once we have done the install clean the pylauncher directory
            # so the tree is not dirty at the end of the run.
            proc.check_call(['git', 'checkout', '.'], cwd=pylauncher_dir)


def EmscriptenLibs(build_dir):
    def WriteEmscriptenConfig(infile, outfile):
        with open(infile) as config:
            text = config.read().replace('{{WASM_INSTALL}}',
                                         WindowsFSEscape(GetInstallDir()))
            text = text.replace('{{PREBUILT_NODE}}',
                                WindowsFSEscape(NodeBin()))
        with open(outfile, 'w') as config:
            config.write(text)

    # Set up the emscripten config and compile the libraries
    buildbot.Step('emscripten')
    config = os.path.join(os.path.dirname(GetInstallDir()), '.emscripten')
    print('Config file: ', config)
    src_config = os.path.join(SCRIPT_DIR, EMSCRIPTEN_CONFIG_TEMPLATE)
    WriteEmscriptenConfig(src_config, config)

    env = os.environ.copy()
    env['EMSDK_PYTHON'] = EMSDK_PYTHON
    # Use emscripten's embuilder to prebuild the system libraries.
    # This depends on binaryen already being built and installed into the
    # archive/install dir.
    embuilder = Executable(GetInstallDir('emscripten', 'embuilder'))
    proc.check_call([embuilder, 'build', 'SYSTEM'], env=env)

    # Remove the sanity file.  This means it will get generated on first
    # use without clearing the cache.
    sanity = GetInstallDir('emscripten', 'cache', 'sanity.txt')
    if os.path.exists(sanity):
        os.remove(sanity)

    # The EMCC_USE_NINJA build will leave intermediate files around. Make sure
    # we don't ship them. (This is safe even if we don't use the ninja build).
    build_dir = GetInstallDir('emscripten', 'cache', 'build')
    if os.path.exists(build_dir):
        shutil.rmtree(build_dir)

    if ShouldUseLTO():
        # Get the version number from the first line of the git commit at HEAD,
        # which should be of the form "Version x.y.z RC"
        # (see create_release_candidate.py).
        git_msg = proc.check_output(
            ['git', 'show', '-s', '--format=%s', 'HEAD'],
            cwd=ROOT_DIR).strip().decode('utf-8')
        m = re.match(r'Version (\d+\.\d+\.\d+) RC', git_msg)
        if not m:
            raise Exception(f'HEAD commit message "{git_msg}" is not of the '
                            'form "Version x.y.z RC"')
        version = m.group(1)

        # Check the content of the emscripten/emscripten-version.txt file. It
        # is of the form "x.y.z-git" and should match the HEAD commit.
        version_file = GetInstallDir('emscripten', 'emscripten-version.txt')
        with open(version_file) as f:
            version_text = f.read().strip()

        expected_version = version + '-git'
        # If it does not, throw an exception. Keep this check last so that the
        # emscripten install step can still be run locally in a dirty git
        # checkout (this step will throw but emscripten will still be installed
        # and usable).
        if version_text != expected_version:
            raise Exception(f'Version mismatch: HEAD commit says {version} '
                            f'(expecting {expected_version} in file), but '
                            f'file has {version_text}')

        # Update emscripten/emscripten-version.txt to drop the "-git" suffix.
        print('Updating %s to %s' % (version_file, version))
        with open(version_file, 'w') as f:
            f.write('%s\n' % version)


def VerifyMacArtifactsBuildArch(is_cross=False):
    # Ensure that all binaries have the correct architecture. There is
    # currently one exception which is allowed to be x86_64:
    closure_binary = 'google-closure-compiler-macos/compiler'
    print('Verifying architecture of MacOS binaries')
    for root, _dirs, files in os.walk(GetInstallDir()):
        for f in files:
            path = os.path.join(root, f)
            with open(path, 'rb') as fd:
                header = fd.read(8)
                if len(header) < 8:
                    continue
                is_macho = struct.unpack_from('I', header)[0] == 0xfeedfacf
                if not is_macho:
                    continue
                cpu_type = struct.unpack_from('I', header, 4)[0]
                is_x86_64 = cpu_type == 0x1000007
                is_arm64 = cpu_type == 0x100000c
                expect_x86 = (IsArm64() and is_cross) or (not IsArm64() and not is_cross)
                if (expect_x86 and is_arm64) or (not expect_x86 and is_x86_64):
                    print(f'{path} is the wrong architecture:')
                    proc.check_call(['file', path])
                    if path.endswith(closure_binary):
                        print('path is closure, ignoring')
                    else:
                        raise Exception('Bad architecture in package')


def ArchiveBinaries(is_cross=False):
    buildbot.Step('Archive binaries')
    # Archive everything in the install directory.
    # Currently we archive x86-64 and arm64/aarch64 binaries on Mac and Linux.
    # For historical reasons (first we had only x86-64 binaries, and then we
    # only had ARM binaries on mac, where the architecture is named 'arm64'),
    # the x86 version has no filename suffix, and the ARM version has '-arm64'
    filename = 'wasm-binaries'
    if (not IsArm64() and is_cross) or (IsArm64() and not is_cross):
        filename += '-arm64'
    if IsMac():
        VerifyMacArtifactsBuildArch(is_cross=is_cross)
    archive = Archive(GetInstallDir(), print_content=buildbot.IsBot())

    # Also make a local copy for running tests.
    if (IsMac() or IsLinux()) and not is_cross:
        copy = os.path.join(os.path.dirname(archive), 'test-install.tar.xz')
        print(f'Copying {archive} to {copy}')
        shutil.copy(archive, copy)

    UploadArchive(filename, archive)


def ExtractArchive():
    Remove(GetInstallDir())
    upper_dir = os.path.dirname(GetInstallDir())
    proc.check_call(['tar', '-xvf',
        os.path.join(upper_dir, 'test-install.tar.xz')],
        cwd=upper_dir)


class Build:
    def __init__(self, name_, runnable_,
                 incremental_build_dir=None,
                 clobber_lto=True,
                 *args, **kwargs):
        self.name = name_
        self.runnable = runnable_
        self.incremental_build_dir = incremental_build_dir
        self.clobber_lto = clobber_lto
        self.args = args
        self.kwargs = kwargs

        if incremental_build_dir:
            self.kwargs['build_dir'] = incremental_build_dir

    def Run(self):
        # When using LTO we always want a clean build (the previous
        # build was non-LTO)
        if self.incremental_build_dir and ShouldUseLTO():
            RemoveIfBot(self.incremental_build_dir)
        try:
            if host_toolchains.UsingReclient() and not buildbot.IsBot():
                host_toolchains.StartReproxy(host_toolchains.GetHostPlatform())
            self.runnable(*self.args, **self.kwargs)
        except Exception:
            # If the build fails (even non-LTO), a possible cause is a build
            # config change, so clobber the work dir for next time.
            if self.incremental_build_dir:
                RemoveIfBot(self.incremental_build_dir)
            raise
        finally:
            # When using LTO we want to always clean up afterward,
            # (the next build will be non-LTO).
            if self.incremental_build_dir and ShouldUseLTO() and self.clobber_lto:
                RemoveIfBot(self.incremental_build_dir)


def Summary():
    buildbot.Step('Summary')

    print('Failed steps: %s.' % buildbot.Failed())
    for step in buildbot.FailedList():
        print('    %s' % step)
    print('Warned steps: %s.' % buildbot.Warned())
    for step in buildbot.WarnedList():
        print('    %s' % step)

    if buildbot.Failed():
        buildbot.Fail()


def TestCompression():
    print('Testing compression tools...')
    with tempfile.TemporaryDirectory() as temp_dir:
        test_dir = os.path.join(temp_dir, 'test_dir')
        os.makedirs(test_dir)
        test_file = os.path.join(test_dir, 'test.txt')
        with open(test_file, 'w') as f:
            f.write('Emscripten Releases compression test content\n' * 50)

        # 1. Test zip compression with ZIP_DEFLATED (used on Windows bots)
        zip_path = os.path.join(temp_dir, 'test.zip')
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.write(test_file, 'test.txt')
        assert os.path.isfile(zip_path) and os.path.getsize(zip_path) > 0

        # 2. Test tar compression with the commands used by uploading bots
        if not IsWindows():
            tar_path = os.path.join(temp_dir, 'test.tar.xz')
            if IsMac():
                cmd = ['tar', 'cJf', tar_path, 'test_dir']
            else:
                cmd = ['tar', '--use-compress-program', 'xz -T0', '-cf', tar_path, 'test_dir']
            proc.check_call(cmd, cwd=temp_dir)
            assert os.path.isfile(tar_path) and os.path.getsize(tar_path) > 0


def CheckEnvironment():
    buildbot.Step('Check environment & tools')

    # 1. Verify core host tools on PATH
    for tool in ('cmake', 'ninja', 'node', 'npm', 'git'):
        print(f'Checking {tool}: {proc.Which(tool)}')
        proc.check_call([tool, '--version'])

    # 2. Verify compression tools and libraries (tar/xz, zip)
    TestCompression()

    # 3. Verify Cloud SDK and GCS connectivity
    cloud.ListBuilds('36767eb2cfa15eab9b22df0c7015925891cf74b1')

    # 4. Verify release script dependencies & version parsing
    proc.check_call([sys.executable, os.path.join(SCRIPT_DIR, 'trigger_emsdk_release.py'),
                     '--check'])


# TODO: Now that we've gotten rid of the complex filtering mechanism, we can
# use a better data structure for this.
def AllBuilds():
    return [
        Build('check-env', CheckEnvironment),
        # Host tools
        Build('libcxx', LibCXX,
              incremental_build_dir=GetBuildDir('libcxx-out')),
        Build('libcxx-cross', LibCXX,
              incremental_build_dir=GetBuildDir('libcxx-cross-out'),
              is_cross=True),
        Build('llvm', LLVM,
              incremental_build_dir=GetBuildDir('llvm-out'),
              clobber_lto=IsWindows()),
        Build('llvm-cross', LLVM,
              incremental_build_dir=GetBuildDir('llvm-cross-out'),
              is_cross=True),
        Build('llvm-test-depends', LLVMTestDepends),
        Build('binaryen', Binaryen,
              incremental_build_dir=GetBuildDir('binaryen-out')),
        Build('binaryen-cross', Binaryen,
              incremental_build_dir=GetBuildDir('binaryen-cross-out'),
              is_cross=True),
        Build('emscripten', Emscripten),
        Build('emscripten-cross', Emscripten, is_cross=True),
        # If the emscripten libs build fails, clobber the LLVM directory.
        # See https://github.com/llvm/llvm-project/issues/156744
        Build('emscripten-libs', EmscriptenLibs,
              incremental_build_dir=GetBuildDir('llvm-out')),
        # Archive
        Build('archive', ArchiveBinaries),
        Build('archive-cross', ArchiveBinaries, is_cross=True),
        Build('extract-archive', ExtractArchive),
    ]


def BuildRepos(builds):
    for b in FilterTargets(builds, AllBuilds()):
        b.Run()


class Test:
    def __init__(self, name_, runnable_):
        self.name = name_
        self.runnable = runnable_

    def Test(self):
        self.runnable()


def ExecuteEmscriptenTestSuite(name, tests, outdir, warn_only=False):
    buildbot.Step('Execute emscripten testsuite (%s)' % name)
    Mkdir(outdir)

    # Before we can run the tests we prepare the installed emscripten
    # directory by copying of some test data which is otherwise excluded by
    # emscripten install script (tools/install.py).  Same for tools/maint.
    em_install_dir = GetInstallDir('emscripten')

    for dirname in (os.path.join('test', 'third_party'),
                    os.path.join('tools', 'maint')):
        installed_dir = os.path.join(em_install_dir, dirname)
        if not os.path.exists(installed_dir):
            src_dir = GetSrcDir('emscripten', dirname)
            print('Copying directory %s to %s' % (src_dir, em_install_dir))
            shutil.copytree(src_dir, installed_dir, symlinks=True)

    # We also need to run npm to get the devDependencies needed by the
    # test suite.
    # Ideally we would put this inside the above block/condition but there
    # is a bug on win32 that is currently causing 'test/third_party' to
    # be installed by install.py.
    print('Running npm install ...')
    proc.check_call(['npm', 'ci'], cwd=em_install_dir)

    cmd = [Executable(GetInstallDir('emscripten', 'test', 'runner'))] + tests
    test_env = os.environ.copy()
    test_env['EMTEST_SKIP_V8'] = '1'
    test_env['EMTEST_SKIP_SCONS'] = '1'
    test_env['EMTEST_SKIP_MESON'] = '1'
    test_env['EMTEST_SKIP_CCACHE'] = '1'
    # Our bots don't currently have a recent enough version of node installed
    # to run tests for recent wasm features such as wasm64, wasm EH, or simd.
    test_env['EMTEST_SKIP_WASM64'] = '1'
    # Remove this legacy variable once emscripten rolls.
    test_env['EMTEST_SKIP_EH'] = '1'
    test_env['EMTEST_SKIP_WASM_EH'] = '1'
    test_env['EMTEST_SKIP_WASM_LEGACY_EH'] = '1'
    test_env['EMTEST_SKIP_JSPI'] = '1'
    test_env['EMTEST_SKIP_NODE_CANARY'] = '1'
    test_env['EMTEST_SKIP_NODE_25'] = '1'
    test_env['EMTEST_SKIP_RUST'] = '1'
    test_env['EMTEST_SKIP_NEW_CMAKE'] = '1'
    # Don't run known flaky tests on the emscripten-releases waterfall.  This
    # avoid the rollers failing due to a flaky test.  We continue to run these
    # on the github CI.
    test_env['EMTEST_SKIP_FLAKY'] = '1'
    test_env['EMSDK_PYTHON'] = EMSDK_PYTHON
    test_env['EMTEST_BENCHMARKERS'] = 'size'
    if not IsLinux():
        test_env['EMTEST_LACKS_NATIVE_CLANG'] = '1'
        test_env['EMTEST_SKIP_PKG_CONFIG'] = '1'

    # On Mac, the closure compiler only supports one of x86-64/arm64. Allow
    # fallback to Java.
    if IsMac():
        test_env['JAVA_HOME'] = JavaHomeDir()
        AddToPath(JavaPath())

    try:
        proc.check_call(cmd, cwd=outdir, env=test_env)
    except proc.CalledProcessError:
        buildbot.FailUnless(lambda: warn_only)


def TestEmtest():
    tests = options.test_params if options.test_params else ['wasm2', 'other']
    ExecuteEmscriptenTestSuite('emwasm', tests,
                               GetTestDir('emtest-out'))


def GetSkiaPerfRemoteFilename(hash, suffix=''):
    # Follow the filename format specified at
    # https://skia.googlesource.com/buildbot/+/refs/heads/main/perf/FORMAT.md#storage
    return datetime.now(UTC).strftime('%Y/%m/%d') + '/' + hash + suffix + '.json'


def TestSizeBenchmarks():
    test_dir = GetInstallDir('emscripten')
    ExecuteEmscriptenTestSuite('emwasm', options.test_params,
                               GetTestDir('emtest-out'))
    stats_filename = os.path.join(test_dir, 'out', 'test', 'stats.json')
    with open(stats_filename) as results_fd:
        json_results = json.loads(results_fd.read())

    # Embed the git revision in the file.
    hash = GitRevision()
    json_results['git_hash'] = hash
    with open(stats_filename, 'w') as results_fd:
        results_fd.write(json.dumps(json_results, indent=2) + '\n')

    remote_filename = GetSkiaPerfRemoteFilename(hash)
    cloud.UploadSkiaPerf(stats_filename, remote_filename)


def TestOptimizationBenchmarks():
    buildbot.Step('Optimization Benchmarks')
    wasm_opt = Executable(GetInstallDir('bin', 'wasm-opt'))

    files = [
        os.path.join(ROOT_DIR, 'third_party/wasm-files/dart-pop.unopt.wasm'),
        os.path.join(ROOT_DIR, 'third_party/wasm-files/dart-flute-complex.unopt.wasm'),
    ]

    results = []

    out_dir = GetBuildDir('wasm-files')
    Mkdir(out_dir)

    for f in files:
        basename = os.path.basename(f)
        out_file = os.path.join(out_dir, basename)

        cmd = [
            wasm_opt,
            '--enable-gc', '--enable-reference-types', '--enable-multivalue',
            '--enable-exception-handling', '--enable-nontrapping-float-to-int',
            '--enable-sign-ext', '--enable-bulk-memory', '--enable-threads',
            '--enable-simd', '--no-inline=*<noInline>*', '--closed-world',
            '--traps-never-happen', '--type-unfinalizing', '-Os', '--type-ssa',
            '--gufa', '-Os', '--type-merging', '-Os', '--type-finalizing',
            '--minimize-rec-groups',
            '-o', out_file,
            f,
        ]

        print(f'Running benchmark for {basename}...')
        start_time = time.time()
        proc.check_call(cmd)
        duration = time.time() - start_time

        results.append({
            'key': {
                'test': f'wasm-opt-time_{basename}',
                'units': 's',
            },
            'measurement': duration,
        })
        results.append({
            'key': {
                'test': f'wasm-opt-size_{basename}',
                'units': 'bytes',
            },
            'measurement': os.path.getsize(out_file),
        })
        with open(out_file, 'rb') as out_file_f:
            gzipped_size = len(zlib.compress(out_file_f.read()))
        results.append({
            'key': {
                'test': f'wasm-opt-gzip-size_{basename}',
                'units': 'bytes',
            },
            'measurement': gzipped_size,
        })

    # Construct Skia Perf JSON
    hash = GitRevision()
    perf_data = {
        'version': 1,
        'git_hash': hash,
        'key': {
            'bot': 'linux-x64-builder',
        },
        'results': results,
    }

    stats_filename = GetTempDir('opt_benchmarks.json')
    with open(stats_filename, 'w') as f:
        f.write(json.dumps(perf_data, indent=2) + '\n')

    remote_filename = GetSkiaPerfRemoteFilename(hash, suffix='-wasm-opt')

    if os.environ.get('SKIP_UPLOAD'):
        print(f'Skipping upload. Results saved to {stats_filename}')
    else:
        cloud.UploadSkiaPerf(stats_filename, remote_filename)


def TestLLVMTestSuite():
    buildbot.Step('Execute LLVM TestSuite')

    if options.apply_test_patches:
        ApplyPatches(os.path.join(ROOT_DIR, 'patches', 'llvm-test-suite'),
                     GetSrcDir('llvm-test-suite'))

    test_suite_c_flags = '-msimd128 -mtail-call -sWASM_LEGACY_EXCEPTIONS=0 -sSUPPORT_LONGJMP=wasm'
    test_suite_cxx_flags = test_suite_c_flags + ' -fwasm-exceptions'
    try:
        outdir = GetBuildDir('llvmtest-out')
        # The compiler changes on every run, so incremental builds don't make
        # sense.
        Remove(outdir)
        Mkdir(outdir)
        # The C++ tests explicitly link libstdc++ for some reason, but we use
        # libc++ and it's unnecessary to link it anyway. So create an empty
        # libstdc++.a
        proc.check_call([GetInstallDir('bin', 'llvm-ar'), 'rc', 'libstdc++.a'],
                        cwd=outdir)
        # This has to be in the environment and not TEST_SUITE_EXTRA_C_FLAGS
        # because CMake doesn't append the flags to the try-compiles.
        command = [GetInstallDir('emscripten', 'emcmake')] + CMakeCommandBase() + [
            GetSrcDir('llvm-test-suite'), '-DCMAKE_C_COMPILER=' +
            GetInstallDir('emscripten', 'emcc'), '-DCMAKE_CXX_COMPILER=' +
            GetInstallDir('emscripten', 'em++'), '-DTEST_SUITE_RUN_UNDER=' +
            NodeBin() + ' --experimental-wasm-exnref',
            '-DTEST_SUITE_USER_MODE_EMULATION=ON',
            '-DTEST_SUITE_SUBDIRS=SingleSource;MicroBenchmarks;MultiSource',
            # The tests for the in-progress matrix extension don't currently work.
            '-DCOMPILER_HAS_MATRIX_FLAG=OFF',
            '-DTEST_SUITE_EXTRA_EXE_LINKER_FLAGS=' +
            '-L %s -sTOTAL_MEMORY=1024MB -sEXIT_RUNTIME ' % outdir +
            '-lnodefs.js -sNODERAWFS -sSTACK_SIZE=512KB -sASSERTIONS=1 ' +
            '-sPTHREAD_POOL_SIZE=2 -sWASM_LEGACY_EXCEPTIONS=0 -sSUPPORT_LONGJMP=wasm -O3',
            '-DCMAKE_STRIP=' + GetInstallDir('emscripten', 'emstrip.py'),
            '-DTEST_SUITE_LLVM_SIZE=' + GetInstallDir('emscripten', 'emsize.py'),
            '-DTEST_SUITE_EXTRA_CXX_FLAGS=' + test_suite_cxx_flags,
            '-DTEST_SUITE_EXTRA_C_FLAGS=' + test_suite_c_flags,
        ]

        proc.check_call(command, cwd=outdir)
        tests = options.test_params if options.test_params else []
        proc.check_call(['ninja', '-v'] + tests, cwd=outdir)
        results_file = 'results.json'
        lit = GetBuildDir('llvm-out', 'bin', 'llvm-lit')
        proc.call([lit, '-v', '-o', results_file, '.'], cwd=outdir)

        with open(os.path.join(outdir, results_file)) as results_fd:
            json_results = json.loads(results_fd.read())

        def get_names(code):
            # Strip the unnecessary spaces from the test name
            return [
                r['name'].replace('test-suite :: ', '')
                for r in json_results['tests'] if r['code'] == code
            ]

        failures = get_names('FAIL')
        successes = get_names('PASS')

        expected_failures = testing.parse_exclude_files(
            RUN_LLVM_TESTSUITE_FAILURES, [])
        unexpected_failures = [f for f in failures if f not in expected_failures]
        unexpected_successes = [f for f in successes if f in expected_failures]

        if len(unexpected_failures) > 0:
            print('Emscripten unexpected failures:')
            for test in unexpected_failures:
                print(test)
        if len(unexpected_successes) > 0:
            print('Emscripten unexpected successes:')
            for test in unexpected_successes:
                print(test)

        if len(unexpected_failures) + len(unexpected_successes) > 0:
            buildbot.Fail()
    finally:
        if options.cleanup_test_patches:
            UnapplyPatches(GetSrcDir('llvm-test-suite'))


def TestBinaryenJS():
    AddToPath(GetInstallDir('emscripten'))
    outdir = GetBuildDir('binaryenjs-test-out')
    Mkdir(outdir)
    test_env = os.environ.copy()
    # On Mac, the closure compiler only supports one of x86-64/arm64. Allow
    # fallback to Java.
    if IsMac():
        test_env['JAVA_HOME'] = JavaHomeDir()
        AddToPath(JavaPath())
    proc.check_call([GetSrcDir('binaryen', 'scripts', 'emcc-tests.sh')],
                    cwd=outdir, env=test_env)


ALL_TESTS = [
    Test('llvm-regression', TestLLVMRegression),
    # These tests do have interesting differences on OSes (especially the
    # 'other' tests) and eventually should run everywhere.
    Test('emtest', TestEmtest),
    Test('llvmtest', TestLLVMTestSuite),
    Test('sizebenchmarks', TestSizeBenchmarks),
    Test('optimizationbenchmarks', TestOptimizationBenchmarks),
    Test('binaryenjs', TestBinaryenJS),
]


def TextWrapNameList(prefix, items):
    width = 80  # TODO(binji): better guess?
    names = sorted(item.name for item in items)
    return '%s%s' % (prefix,
                     textwrap.fill(' '.join(names),
                                   width,
                                   initial_indent='  ',
                                   subsequent_indent='  '))


def ParseArgs():
    def SplitComma(arg):
        if not arg:
            return None
        return arg.split(',')

    epilog = '\n\n'.join([
        TextWrapNameList('sync targets:\n', AllSources()),
        TextWrapNameList('build targets:\n', AllBuilds()),
        TextWrapNameList('test targets:\n', ALL_TESTS),
    ])

    parser = argparse.ArgumentParser(
        description='Wasm waterfall top-level CI script',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=epilog)

    parser.add_argument(
        '--sync-dir', dest='sync_dir', help='Directory for syncing sources')
    parser.add_argument(
        '--build-dir', dest='build_dir', help='Directory for build output')
    parser.add_argument(
        '--prebuilt-dir', dest='prebuilt_dir',
        help='Directory for prebuilt output')
    parser.add_argument(
        '--v8-dir', dest='v8_dir',
        help='Directory for V8 checkout/build')
    parser.add_argument(
        '--test-dir', dest='test_dir', help='Directory for test output')
    parser.add_argument(
        '--install-dir', dest='install_dir',
        help='Directory for installed output')

    parser.add_argument(
        '--sync-include', dest='sync_include', default='', type=SplitComma,
        help='Include only the comma-separated list of sync targets')

    parser.add_argument(
        '--build-include', dest='build_include', default='', type=SplitComma,
        help='Include only the comma-separated list of build targets')

    parser.add_argument(
        '--test-include', dest='test_include', default='', type=SplitComma,
        help='Include only the comma-separated list of test targets')

    parser.add_argument(
        '--test-params', dest='test_params', default='', type=SplitComma,
        help='Test selector to pass through to emscripten testsuite runner')

    parser.add_argument(
        '--no-threads', action='store_true',
        help='Disable use of thread pool to building and testing')
    parser.add_argument(
        '--no-host-clang', dest='host_clang', action='store_false',
        help="Don't force chrome clang as the host compiler")
    parser.add_argument(
        '--no-sysroot', dest='use_sysroot', action='store_false',
        help="Don't use the V8 sysroot to build on Linux/macOS")
    parser.add_argument(
        '--clobber', dest='clobber', default=False, action='store_true',
        help="Delete working directories, forcing a clean build")
    parser.add_argument(
        '--no-test-patches', dest='apply_test_patches', default=True, action='store_false',
        help="Skip applying patches to tests before running")
    parser.add_argument(
        '--no-test-cleanup', dest='cleanup_test_patches', default=True, action='store_false',
        help="Skip cleaning up patched changes in tests after running")
    parser.add_argument(
        '--use-lto', dest='use_lto', default=False, action='store',
        choices=['true', 'false', 'auto'],
        help='Use extra optimization for host binaries')
    parser.add_argument(
        '--link-static', dest='link_static', default=False, action='store_true',
        help='Link LLVM statically instead of using the libLLVM dylib'
             ' (required to run the LLVM regression tests)')
    parser.add_argument(
        '--llvm-linker', dest='llvm_linker', default='lld',
        choices=['lld', 'mold', 'gold', 'bfd'],
        help='Linker to use for building LLVM (lld, mold, gold, bfd)')

    return parser.parse_args()


def AddToPath(path):
    print("adding to path: %s" % path)
    os.environ['PATH'] = path + os.pathsep + os.environ['PATH']


def run(sync_targets, build_targets, test_targets):
    Clobber()
    Chdir(SCRIPT_DIR)
    for work_dir in work_dirs.GetAll():
        Mkdir(work_dir)
    SyncRepos(sync_targets)

    # Add prebuilt cmake to PATH so any subprocesses use a consistent cmake.
    AddToPath(os.path.dirname(PrebuiltCMakeBin()))

    # Add ninja to the PATH (needed for both cmake and for running emscripten
    # tests).
    AddToPath(NINJA_DIR)

    # Add gcloud to the PATH (needed for cloud storage uploads/downloads).
    AddToPath(GCLOUD_DIR)

    # `npm` uses whatever `node` is in `PATH`. To make sure it uses the
    # Node.js version we want, we prepend the node bin dir to `PATH`.
    AddToPath(NodeBinDir())

    try:
        BuildRepos(build_targets)
    except Exception:
        # If any exception reaches here, do not attempt to run the tests; just
        # log the error for buildbot and exit
        print("Exception thrown in build step.")
        traceback.print_exc()
        buildbot.Fail()
        Summary()
        return 1

    for t in FilterTargets(test_targets, ALL_TESTS):
        t.Test()

    # Keep the summary step last: it'll be marked as red if the return code is
    # non-zero. Individual steps are marked as red with buildbot.Fail().
    Summary()
    return buildbot.Failed()


def main():  # noqa
    global options
    start = time.time()
    options = ParseArgs()
    print('Python version %s' % sys.version)
    print('sys.executable = %s' % sys.executable)
    print('EMSDK_PYTHON = %s' % EMSDK_PYTHON)

    if options.no_threads:
        testing.single_threaded = True

    if options.sync_dir:
        work_dirs.SetSync(options.sync_dir)
    if options.build_dir:
        work_dirs.SetBuild(options.build_dir)
    if options.v8_dir:
        work_dirs.SetV8(options.v8_dir)
    if options.test_dir:
        work_dirs.SetTest(options.test_dir)
    if options.install_dir:
        work_dirs.SetInstall(options.install_dir)
    if options.prebuilt_dir:
        work_dirs.SetPrebuilt(options.prebuilt_dir)
    if not options.host_clang:
        host_toolchains.SetForceHostClang(False)
    if not options.use_sysroot:
        host_toolchains.SetUseSysroot(False)

    sync_include = options.sync_include if options.sync_include else []
    build_include = options.build_include if options.build_include else []
    test_include = options.test_include if options.test_include else []

    try:
        ret = run(sync_include, build_include, test_include)
        print(f'Completed in {time.time() - start}s')
        return ret
    except:  # noqa
        traceback.print_exc()
        # If an except is raised during one of the steps we still need to
        # print the @@@STEP_FAILURE@@@ annotation otherwise the annotator
        # makes the failed stap as green:
        # TODO(sbc): Remove this if the annotator is fixed:
        # http://crbug.com/647357
        if buildbot.current_step:
            buildbot.Fail()
        return 1


if __name__ == '__main__':
    sys.exit(main())
