# Copyright 2019 the V8 project authors. All rights reserved.
# Use of this source code is governed by a BSD-style license that can be
# found in the LICENSE file.


vars = {
  'binaryen_url': 'https://chromium.googlesource.com/external/github.com/WebAssembly/binaryen',
  'emscripten_url': 'https://chromium.googlesource.com/external/github.com/emscripten-core/emscripten',
  'llvm_project_url': 'https://chromium.googlesource.com/external/github.com/llvm/llvm-project',
  'v8_url': 'https://chromium.googlesource.com/v8/v8',
  # WARNING: This is a mirror of the old LLVM git mirror of the SVN repo. The github
  # repo URL is different, and has different hashes.
  'llvm-test-suite_url': 'https://chromium.googlesource.com/native_client/pnacl-llvm-testsuite',
  # TODO: v8 for testing, Gcc for torture tests, Update llvm test-suite to github

  # Three lines of non-changing comments so that
  # the commit queue can handle CLs rolling binaryen
  # and whatever else without interference from each other.
  'binaryen_revision': '8d546dc4aea1c3e81e77643f1ed0dea1a649d21d',
  # Three lines of non-changing comments so that
  # the commit queue can handle CLs rolling emscripten
  # and whatever else without interference from each other.
  'emscripten_revision': 'aeb67926e7de656da38bc807d83050af93578758',
  # Three lines of non-changing comments so that
  # the commit queue can handle CLs rolling llvm_project
  # and whatever else without interference from each other.
  'llvm_project_revision': 'c0125a7bf833b6cf0d5b4a085b63094e0893c85a',
  # Three lines of non-changing comments so that
  # the commit queue can handle CLs rolling v8
  # and whatever else without interference from each other.
  'v8_revision': 'd9740b53ddd6e9f2a86492c0fac070a41ce7ef67',
  # Three lines of non-changing comments so that
  # the commit queue can handle CLs rolling llvm_test_suite
  # and whatever else without interference from each other.
  'llvm-test-suite_revision': '6c6a59906becace341d439cb7e45a56a4b96640a',
}

deps = {
  'emscripten-releases/binaryen': Var('binaryen_url') + '@' + Var('binaryen_revision'),
  'emscripten-releases/emscripten': Var('emscripten_url') + '@' + Var('emscripten_revision'),
  'emscripten-releases/llvm-project': Var('llvm_project_url') + '@' + Var('llvm_project_revision'),
  'v8': Var('v8_url') + '@' + Var('v8_revision'),
  'emscripten-releases/llvm-test-suite': Var('llvm-test-suite_url') + '@' + Var('llvm-test-suite_revision'),
  'emscripten-releases/third_party/ninja': {
    'packages': [
      {
        'package': 'infra/3pp/tools/ninja/${{platform}}',
        'version': 'version:3@1.13.2.chromium.4',
      }
    ],
    'dep_type': 'cipd',
  },
  'emscripten-releases/third_party/gcloud': {
    'packages': [
      {
        'package': 'infra/3pp/tools/gcloud/${{platform}}',
        'version': 'version:3@579.0.0.chromium.4',
      }
    ],
    'dep_type': 'cipd',
  },
  'emscripten-releases/third_party/wasm-files': {
    'dep_type': 'gcs',
    'bucket': 'webassembly',
    'objects': [
      {
        'object_name': 'emscripten-releases-builds/deps/test-files/dart-pop.unopt.wasm',
        'sha256sum': '9ff90dc215c503224b56ecbaed9ce2db7d70c929281d3b0380ba921a239642e5',
        'size_bytes': 1330046,
        'generation': 1776963812644460,
        'output_file': 'dart-pop.unopt.wasm',
      },
      {
        'object_name': 'emscripten-releases-builds/deps/test-files/dart-flute-complex.unopt.wasm',
        'sha256sum': 'd63e2a789aad8af871124937ae8b64c28a0d1ca2b9131ec33ddde35cd7c9410a',
        'size_bytes': 4410188,
        'generation': 1776963981165463,
        'output_file': 'dart-flute-complex.unopt.wasm',
      }
    ]
  },
  'emscripten-releases/jdk-26_macos-aarch64_bin': {
    'dep_type': 'gcs',
    'condition': 'host_os == "mac" and host_cpu == "arm64"',
    'bucket': 'webassembly',
    'objects': [
      {
        'object_name': 'emscripten-releases-builds/deps/jdk-26_macos-aarch64_bin.tar.gz',
        'sha256sum': '368bdb70170a1f802b7629850500b8691a0885fdce867c38caa100db2a708a91',
        'size_bytes': 213639077,
        'generation': 1778539615643801
      }
    ]
  },
  'emscripten-releases/jdk-26_macos-x64_bin': {
    'dep_type': 'gcs',
    'condition': 'host_os == "mac" and host_cpu == "x64"',
    'bucket': 'webassembly',
    'objects': [
      {
        'object_name': 'emscripten-releases-builds/deps/jdk-26_macos-x64_bin.tar.gz',
        'sha256sum': 'd9b748df71ff233289f9e08aeb5655a5c1c12521849eeadcb51d9a22d0d3089c',
        'size_bytes': 216018798,
        'generation': 1778540142806220
      }
    ]
  }
}

hooks = [
  {
    'name': 'cmake',
    'pattern': '.',
    'action': ['python3', 'emscripten-releases/src/build.py',
               '--sync-include=cmake,nodejs,sysroot',
               '--prebuilt-dir=emscripten-releases', '--v8-dir=v8'],
  },
  {
    'name': 'binaryen_submodule_init',
    'pattern': '.',
    'action': ['git', '-C', 'emscripten-releases/binaryen',
               'submodule', 'update', '--force', '--init'],
  },
]

recursedeps = [
  'v8'
]
