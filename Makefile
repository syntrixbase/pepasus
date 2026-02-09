.PHONY: install test lint lint-fix typecheck coverage clean check

install:
	bun install

test:
	bun test

lint:
	bunx biome check src/ tests/

lint-fix:
	bunx biome check --fix src/ tests/

typecheck:
	bunx tsc --noEmit

coverage:
	bun test --coverage

clean:
	rm -rf node_modules dist coverage *.tsbuildinfo

check: typecheck test
