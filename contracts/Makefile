.PHONY: deploy-sepolia deploy-mainnet test-all coverage

deploy-sepolia:
	mkdir -p deployments
	forge script script/Deploy.s.sol \
		--rpc-url base_sepolia \
		--broadcast \
		--verify \
		--slow

# Base MAINNET deploy. Hard-refuses unless the RPC really is chain 8453 AND CONFIRM_MAINNET=yes.
# Output goes to deployments/base.json (see deployments/README.md). Never run casually.
deploy-mainnet:
	@test "$(CONFIRM_MAINNET)" = "yes" || { echo "REFUSING: set CONFIRM_MAINNET=yes to deploy to Base mainnet"; exit 1; }
	@test -n "$(BASE_RPC_URL)" || { echo "REFUSING: BASE_RPC_URL not set"; exit 1; }
	@test "$$(cast chain-id --rpc-url $(BASE_RPC_URL))" = "8453" || { echo "REFUSING: BASE_RPC_URL is not chain 8453"; exit 1; }
	mkdir -p deployments
	USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 \
	forge script script/Deploy.s.sol \
		--rpc-url base \
		--broadcast \
		--verify \
		--slow

test-all:
	forge test -vvv

coverage:
	forge coverage
