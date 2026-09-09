"""Reuse the accepted one-attempt builder for the single deferred-logits change."""
import argparse
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('reservation_builder', ROOT / 'scripts/issue201/whispercpp-reservation-build/build.py')
driver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(driver)
driver.EVIDENCE = ROOT / 'docs/evidence/issue201/whispercpp-deferred-logits-source'
driver.ATTEMPT = ROOT / '.tmp/issue201-whispercpp-deferred-logits-build'
driver.SOURCE = driver.ATTEMPT / 'source'
driver.RECIPE = driver.ATTEMPT / 'recipe'
driver.LOGS = driver.ATTEMPT / 'logs'
driver.OUTPUT = driver.ATTEMPT / 'output'

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    actions = parser.add_mutually_exclusive_group(required=True)
    actions.add_argument('--verify-inputs', action='store_true')
    actions.add_argument('--prepare-source', action='store_true')
    actions.add_argument('--compile', action='store_true')
    args = parser.parse_args()
    if args.verify_inputs:
        print(json.dumps(driver.verify_inputs(), indent=2))
    elif args.prepare_source:
        print(json.dumps(driver.prepare_source(), indent=2))
    else:
        driver.compile_once()
