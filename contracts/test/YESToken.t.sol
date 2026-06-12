// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {YESToken} from "../src/YESToken.sol";

contract YESTokenTest is Test {
    YESToken token;

    address admin = address(this);
    address minter = makeAddr("minter");
    address burner = makeAddr("burner");
    address clobAddress = makeAddr("clob");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    function setUp() public {
        token = new YESToken(admin);
        token.grantRole(token.MINTER_ROLE(), minter);
        token.grantRole(token.BURNER_ROLE(), burner);
        token.grantRole(token.CLOB_ROLE(), clobAddress);
    }

    function test_MintByAuthorized() public {
        vm.prank(minter);
        token.mint(alice, 1000e18);
        assertEq(token.balanceOf(alice), 1000e18);
        assertEq(token.totalSupply(), 1000e18);
    }

    function test_MintByUnauthorized_Reverts() public {
        bytes32 minterRole = token.MINTER_ROLE(); // cache before prank — external call would consume it
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                minterRole
            )
        );
        token.mint(alice, 1000e18);
    }

    function test_BurnByAuthorized() public {
        vm.prank(minter);
        token.mint(alice, 1000e18);

        vm.prank(burner);
        token.burn(alice, 400e18);

        assertEq(token.balanceOf(alice), 600e18);
        assertEq(token.totalSupply(), 600e18);
    }

    function test_BurnByUnauthorized_Reverts() public {
        vm.prank(minter);
        token.mint(alice, 1000e18);

        bytes32 burnerRole = token.BURNER_ROLE(); // cache before prank
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                burnerRole
            )
        );
        token.burn(alice, 1000e18);
    }

    function test_TransferByClobRole_Succeeds() public {
        vm.prank(minter);
        token.mint(alice, 1000e18);

        // alice approves clobAddress to spend on her behalf (standard ERC-20 allowance)
        vm.prank(alice);
        token.approve(clobAddress, 500e18);

        // clobAddress (CLOB_ROLE) executes the transfer
        vm.prank(clobAddress);
        assertTrue(token.transferFrom(alice, bob, 500e18));

        assertEq(token.balanceOf(alice), 500e18);
        assertEq(token.balanceOf(bob), 500e18);
    }

    function test_DirectTransfer_Reverts() public {
        vm.prank(minter);
        token.mint(alice, 1000e18);

        // alice has no CLOB_ROLE — direct transfer must be blocked
        vm.prank(alice);
        vm.expectRevert(YESToken.TransferRestricted.selector);
        token.transfer(bob, 500e18);
    }

    function test_MintTransferBurn_Succeeds() public {
        // Mint 1000 YES to alice
        vm.prank(minter);
        token.mint(alice, 1000e18);

        // CLOB moves 600 from alice → bob
        vm.prank(alice);
        token.approve(clobAddress, 1000e18);
        vm.prank(clobAddress);
        assertTrue(token.transferFrom(alice, bob, 600e18));

        assertEq(token.balanceOf(alice), 400e18);
        assertEq(token.balanceOf(bob), 600e18);

        // Burn all of bob's tokens (e.g. on credit event settlement)
        vm.prank(burner);
        token.burn(bob, 600e18);

        assertEq(token.balanceOf(bob), 0);
        assertEq(token.totalSupply(), 400e18);
    }
}
