.PHONY: deploy-sepolia test-all coverage

deploy-sepolia:
	mkdir -p deployments
	forge script script/Deploy.s.sol \
		--rpc-url base_sepolia \
		--broadcast \
		--verify \
		--slow

test-all:
	forge test -vvv

coverage:
	forge coverage
