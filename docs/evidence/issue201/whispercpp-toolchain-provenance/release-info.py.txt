#!/usr/bin/env python3

"""Usage: release-info.py <repo> <revision>.

Examples:
Print info about an emscripten-releases revision:
release-info.py emscripten-releases 30825b84
The repo also defaults to emscripten-releases, e.g.:
release-info.py 30825b8
This will print the full hash, timestamp, and tool revisions for the
specified revision

Print info about an llvm-project, binaryen, or emscripten revision:
release-info.py llvm-project <hash>
This will print the first emscripten-releases revision (and tag revision)
that contains the specified tool revision

As a special case, you can print info about a tag version
Examples: release-info.py tag 2.0.16
Or when you use a tag version you can leave out the mode:
release-info.py 2.0.16

"""

# TODO: Support another way to find the checkout directories (i.e. remove the
# current requirement that they be in subdirectories of the cwd)
# TODO: Support automatically fetching the git remotes of the subdirs

import argparse
import json
import os
import subprocess
import sys
import urllib.request

TAG_INFO_URL = 'https://raw.githubusercontent.com/emscripten-core/emsdk/main/emscripten-releases-tags.json'
EMR_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAIN_BRANCH = 'origin/main'


def Git(*args, **kwargs):
    # print('Running: git ' + ' '.join(args))
    return subprocess.check_output(['git'] + list(args), **kwargs).decode()


def RevisionDate(rev, cwd):
    if os.path.isdir(cwd):
        try:
            return Git('log', '-n1', '--pretty=format:%cd', rev, cwd=cwd)
        except subprocess.CalledProcessError:
            pass
    return '(not found)'


def IsAncestor(rev1, rev2, cwd):
    """Return True if rev1 is an ancestor of rev2."""
    # In other words, the history from rev2 includes rev1
    try:
        Git('merge-base', '--is-ancestor', rev1, rev2, cwd=cwd)
        return True
    except subprocess.CalledProcessError as e:
        # Exit status is 1 if rev1 is not an ancestor, something else otherwise
        if e.returncode == 1:
            return False
        raise


def TagEmrInfo():
    """Return tag revision info from EMSDK.

    Map tag version to  emscripten-releases revision.
    Example: { '2.0.16': <hash>, '2.0.15': <hash> }
    """
    info_stream = urllib.request.urlopen(TAG_INFO_URL)
    info = json.load(info_stream)
    # EMSDK's data format includes the latest release, which we don't care
    # about here, e.g.:  { 'latest': '2.0.16', 'releases': {...} }
    return info['releases']


def ParseDeps(deps_str):
    """Parse a DEPS file and return the relevant revisions.

    Structure is { 'emscripten': hash, 'binaryen': hash, 'llvm-project': hash }
    """
    # DEPS files are basically python, with a bit of extra environment required
    # that we can fake.
    def Var(_x):
        return ''
    Globals = {'Var': Var}
    exec(deps_str, Globals)
    Vars = Globals['vars']
    revisions = {
        'emscripten': Vars['emscripten_revision'],
        'binaryen': Vars['binaryen_revision'],
        'llvm-project': Vars['llvm_project_revision'],
    }
    return revisions


def GetDeps(emr_rev):
    """Return the relevant DEPS info for an emscripten-releases revision."""
    # Figure out whether DEPS or DEPS.tagged-release is the correct deps
    changed = Git(
        'show', '--oneline', '--name-only', emr_rev, cwd=EMR_DIR).splitlines()

    if 'DEPS.tagged-release' in changed:
        depsfile = 'DEPS.tagged-release'
    else:
        depsfile = 'DEPS'
    deps_str = Git('show', f'{emr_rev}:{depsfile}', cwd=EMR_DIR)
    return ParseDeps(deps_str)


def PrintEmrToolInfo(emr_rev):
    """Print the date and deps info for an escripten-releases revision."""
    deps = GetDeps(emr_rev)
    emr_rev = Git('rev-parse', emr_rev).strip()
    emr_date = RevisionDate(emr_rev, EMR_DIR)
    print(f'emscripten-releases revision: {emr_rev} ({emr_date})\n')

    for tool, rev in deps.items():
        date = RevisionDate(rev, os.path.join(EMR_DIR, tool))
        print(f'{tool:19} revision: {rev} ({date})')
    return emr_date, deps


def PrintTagFullInfo(tag):
    taginfo = TagEmrInfo()
    emr_rev = taginfo[tag]
    print(f'Revision info for {tag}:')
    return emr_rev, PrintEmrToolInfo(emr_rev)


def TagSortKey(tag):
    # Strip suffix like "-asserts"
    suffix = tag.find('-')
    if suffix != -1:
        tag = tag[:suffix]
    c = tag.split('.')
    return int(c[0]) * 10000 + int(c[1]) * 100 + int(c[2])


def IsTagVersion(revision):
    try:
        TagSortKey(revision)
        return True
    except Exception:
        return False


def EmrTagInfo(emr_rev):
    """Find earliest tag that includes emr_rev."""
    taginfo = TagEmrInfo()
    first_tag = None
    first_emr_rev = None
    # Invoking git merge-base for every tag ever is slow, and most of the
    # revisions we care about are recent. So iterate from the newest first.
    for r in sorted(taginfo.keys(), key=TagSortKey, reverse=True):
        tag_emr_rev = taginfo[r]
        if not IsAncestor(emr_rev, tag_emr_rev, cwd=None):
            # r is the newest tag that does not contain emr_rev
            break
        first_tag = r
        first_emr_rev = tag_emr_rev

    if first_tag is None:
        print(f'No tag version contains {emr_rev}')
    else:
        print(f'{first_tag} is the first tag that contains {emr_rev}')
    return first_tag, first_emr_rev


def ToolTagInfo(tool, tool_rev):
    """Find the earliest tag that contains tool_rev."""
    tool_dir = os.path.join(EMR_DIR, tool)
    tool_rev = Git('rev-parse', tool_rev, cwd=tool_dir).strip()
    taginfo = TagEmrInfo()

    first_tag = None
    first_emr_rev = None
    first_tool_rev = None
    for r in sorted(taginfo.keys(), key=TagSortKey, reverse=True):
        tag_emr_rev = taginfo[r]
        deps = GetDeps(tag_emr_rev)
        tag_tool_rev = deps[tool]
        if not IsAncestor(tool_rev, tag_tool_rev, cwd=tool_dir):
            # r is the newest tag that does not contain tool_rev
            break
        first_tag = r
        first_emr_rev = tag_emr_rev
        first_tool_rev = tag_tool_rev

    if first_tag is None:
        print(f'No tag version contains {tool} rev {tool_rev}')
    else:
        print(f'{first_tag} (emscripten-releases rev {first_emr_rev}) is the '
              f'first tag that contains {tool} rev {tool_rev}')
        print(f'(It includes {tool} rev up to {first_tool_rev})')
    return first_tag, first_emr_rev, first_tool_rev


def FindEmrRevContaining(tool, tool_rev):
    """Find the earliest emscripten-releases rev that contains tool_rev."""
    tool_dir = os.path.join(EMR_DIR, tool)
    tool_rev = Git('rev-parse', tool_rev, cwd=tool_dir).strip()
    first_emr_rev = None
    first_tool_rev = None
    dep_name = tool.replace('-', '_') + '_revision'
    emr_commits = Git('log', MAIN_BRANCH, '--pretty=format:%H', '-G', dep_name,
                      ).strip().split('\n')
    for r in emr_commits:
        emr_rev = r.split()[0]
        deps = GetDeps(emr_rev)
        emr_tool_rev = deps[tool]
        if not IsAncestor(tool_rev, emr_tool_rev, cwd=tool_dir):
            # emr_rev is the newest rev that does not contain tool_rev
            break
        first_emr_rev = emr_rev
        first_tool_rev = emr_tool_rev
    return first_emr_rev, first_tool_rev


def FindEmrRevExact(tool, tool_rev):
    """Find an emscripten-releases rev that updates tool to tool_rev, if any."""
    # This method is much faster but only finds commits that update DEPS to
    # exactly the desired rev. So it only works if every commit is rolled by
    # itself (i.e. not LLVM, and sometimes not other tools) .
    tool_dir = os.path.join(EMR_DIR, tool)
    tool_rev = Git('rev-parse', tool_rev, cwd=tool_dir).strip()
    # Rather than manually searching for the rev that rolled our revision, let
    # git do it for us. We expect to find 0-2 revs
    deps_revs = Git('log', MAIN_BRANCH, '--format=oneline', '-G', tool_rev,
                    ).strip().split('\n')
    assert len(deps_revs) <= 2
    if len(deps_revs) == 0:
        return None, None
    assert 'to ' + tool_rev[:12] in deps_revs[-1]
    emr_rev = deps_revs[-1].split()[0]

    return emr_rev, emr_rev


def PrintEmrRevContaining(tool, tool_rev):
    # Try the fast way first
    emr_rev, first_tool_rev = FindEmrRevExact(tool, tool_rev)
    if emr_rev is None:
        emr_rev, first_tool_rev = FindEmrRevContaining(tool, tool_rev)
    if emr_rev is None:
        print(f'No emscripten-releases rev contains {tool} rev {tool_rev}')
    else:
        print(f'emscripten-releases rev {emr_rev} is the first that contains '
              f'{tool} rev {tool_rev}')
        print(f'(It includes {tool} rev up to {first_tool_rev})')


def test():
    # This is a bad unit tests because it works on real data instead of mock
    # data. So it can't ensure we capture cases like searching for a revision
    # that is not yet in a release.
    date, deps = PrintEmrToolInfo('30825b84')
    assert date == 'Wed Mar 31 15:19:52 2021'
    assert deps['emscripten'] == '0aef720ece71c9950bd388f226c21a2f9be75d04'

    # For a revision which modifies DEPS.tagged-release, ensure that file is
    # used instead of DEPS
    date, deps = PrintEmrToolInfo('3ebc04a3')
    assert deps['emscripten'] == '97c7c2adab1791b9487d1f376934a3bdc28f8a67'

    emr_rev, (date, deps) = PrintTagFullInfo('2.0.15')
    assert emr_rev == '89202930a98fe7f9ed59b574469a9471b0bda7dd'
    assert deps['llvm-project'] == '1c5f08312874717caf5d94729d825c32845773ec'

    # This is ugly but if we choose a single hash it will eventually end up in a
    # revision and this test will fail. It will also fail if HEAD just happens
    # to be a tagged revision
    tag, emr_rev = EmrTagInfo('HEAD')
    assert tag is None and emr_rev is None

    tag, emr_rev = EmrTagInfo('a05ef8f')
    assert tag == '2.0.16'
    assert emr_rev == '80d9674f2fafa6b9346d735c42d5c52b8cc8aa8e'
    tag, emr_rev = EmrTagInfo('d1451d3')
    assert tag == '2.0.14'
    assert emr_rev == 'fc5562126762ab26c4757147a3b4c24e85a7289e'

    tag, emr_rev, tool_rev = ToolTagInfo('llvm-project', 'HEAD')
    assert tag == emr_rev == tool_rev is None

    tag, emr_rev, tool_rev = ToolTagInfo('llvm-project', 'ad8010e5')
    assert tag == '2.0.16'
    assert emr_rev == '80d9674f2fafa6b9346d735c42d5c52b8cc8aa8e'
    assert tool_rev == 'ad8010e598d9aa3747c34ce28aa2ba6de1650bd4'
    tag, emr_rev, tool_rev = ToolTagInfo('binaryen', '4423bcce31d')
    assert tag == '2.0.11'
    assert emr_rev == '4764c5c323a474f7ba28ae991b0c9024fccca43c'
    assert tool_rev == 'a8ded16f56afd880a9a6459fe5ce55a8667d9b3e'

    emr_rev, _ = FindEmrRevExact('binaryen', '4423bcce31')
    assert emr_rev == '13afe1e659088eb091b2a4d22eba6a1968e1bd9c'

    emr_rev, tool_rev = FindEmrRevContaining('llvm-project', 'ae7b1e8823a5')
    assert emr_rev == 'b1db25970643e56641a27fd45c282d405cee355b'
    assert tool_rev == '4ced958dc205de0de935e6d2f27767ebcec6c29f'
    emr_rev, tool_rev = FindEmrRevContaining('binaryen', '4423bcce31')
    assert emr_rev == '13afe1e659088eb091b2a4d22eba6a1968e1bd9c'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Info about emscripten-releases and tool revisions')
    parser.add_argument('mode', nargs='?', choices=[
        'tag', 'emscripten-releases', 'llvm-project', 'binaryen',
        'emscripten', 'test'], help='Type of revision to print info about')
    parser.add_argument('revision', help='Tag version or git revision')
    args = parser.parse_args()

    if args.revision == 'test':
        sys.exit(test())
    if IsTagVersion(args.revision):
        if args.mode and args.mode != 'tag':
            print("Tag revisions such as 2.0.16 can't be used as %s revisions "
                  % args.mode)
            sys.exit(1)
        PrintTagFullInfo(args.revision)
    elif not args.mode or args.mode == 'emscripten-releases':
        PrintEmrToolInfo(args.revision)
    elif args.mode in {'llvm-project', 'binaryen', 'emscripten'}:
        tag, emr_rev, tool_rev = ToolTagInfo(args.mode, args.revision)
        if not tag:
            PrintEmrRevContaining(args.mode, args.revision)
        if tag:
            PrintTagFullInfo(tag)
        elif emr_rev:
            PrintEmrToolInfo(emr_rev)
