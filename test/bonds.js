const { expect } = require("chai");
const { ethers } = require("hardhat");
const { mine } = require("@nomicfoundation/hardhat-network-helpers");


describe("ENS delegate with bond", () => {
    let snapshot;
    let governor;
    let ensToken;
    let timelockController;
    let owner;
    let account2;
    let account3;

    // Constants used in the tests
    const TOKEN_INITIAL_SUPPLY = ethers.BigNumber.from("10000000000000000000000000");
    const VOTING_DELAY = 1;
    const PROPOSAL_THRESHOLD = ethers.BigNumber.from("100000000000000000000000");
    const TARGETS_COUNT = 1;
    const VOTING_PERIOD = 46818;

    // Proposal state enum
    const ProposalState = {
        Pending: 0,
        Active: 1,
        Canceled: 2,
        Defeated: 3,
        Succeeded: 4,
        Queued: 5,
        Expired: 6,
        Executed: 7,
    };

    // Custom vote types enum
    const VoteType = {
        Against: 0,
        For: 1,
        Abstain: 2,
        AgainstWithoutBondReturn: 3, // Custom vote type for bond logic
    };

    beforeEach(async () => {
        const signers = await ethers.getSigners();
        owner = signers[0];
        account2 = signers[1];
        account3 = signers[2];

        const ENSInstance = await ethers.getContractFactory("ENSToken");
        ensToken = await ENSInstance.deploy(TOKEN_INITIAL_SUPPLY, '0', '0');

        const TimelockControllerInstance = await ethers.getContractFactory("TimelockControllerMock");
        timelockController = await TimelockControllerInstance.deploy(VOTING_DELAY, [owner.address], [owner.address,]);

        const GovernorInstance = await ethers.getContractFactory("ENSGovernorV2");
        governor = await GovernorInstance.deploy(ensToken.address, timelockController.address);
        timelockController.approveERC20ForGovernor(ensToken.address, governor.address);
    });

    beforeEach(async () => {
        snapshot = await ethers.provider.send('evm_snapshot', []);
    });

    afterEach(async () => {
        await ethers.provider.send('evm_revert', [snapshot]);
    });

    // Test case to verify if bond is refunded after the end of vote on proposal
    it("should return bond after finish proposal", async () => {
        // Initial balance setup
        const account2Balance = PROPOSAL_THRESHOLD;
        await ensToken.transfer(account2.address, account2Balance);
        await ensToken.connect(account2).delegate(account2.address);

        // Calculate bond amount and approve transfer
        const bondAmount = await governor.calculateBond(TARGETS_COUNT);
        await ensToken.connect(account2).approve(governor.address, bondAmount);

        // Check balance before proposal
        const balanceBeforeProposeWithBond = await ensToken.balanceOf(account2.address);
        expect(account2Balance).to.equal(balanceBeforeProposeWithBond);

        // Propose with bond
        let proposeTx = await governor.connect(account2).proposeWithBond(
            [account2.address],
            [0],
            ['0x'],
            ''
        );

        // Get proposal details and verify state and balance after proposal
        const receipt = await proposeTx.wait();
        const balanceAfterProposeWithBond = await ensToken.balanceOf(account2.address);
        const proposalId = receipt.events[0].args.proposalId;
        const state = await governor.state(proposalId);

        expect(state).to.equal(ProposalState.Pending);
        expect(balanceAfterProposeWithBond).to.equal(balanceBeforeProposeWithBond.sub(bondAmount));

        await mine(1);
        await governor.state(proposalId);
        await mine(VOTING_PERIOD);
        await governor.state(proposalId);

        // Refund the proposal and check if bond is returned
        await governor.connect(account2).refundBond(proposalId);

        const balanceAfterCancelProposeWithBond = await ensToken.balanceOf(account2.address);
        expect(balanceBeforeProposeWithBond).to.equal(balanceAfterCancelProposeWithBond);
    });

    // Test case to verify if bond is saved on timeLockController contract
    it("should save tokens on timeLockController contract if bond not returned", async () => {
        // Initial balance setup
        const account2Balance = PROPOSAL_THRESHOLD;
        await ensToken.transfer(account2.address, account2Balance);
        await ensToken.connect(account2).delegate(account2.address);

        // Calculate bond amount and approve transfer
        const bondAmount = await governor.calculateBond(TARGETS_COUNT);
        await ensToken.connect(account2).approve(governor.address, bondAmount);

        // Check balance before proposal
        const balanceBeforeProposeWithBond = await ensToken.balanceOf(account2.address);
        expect(account2Balance).to.equal(balanceBeforeProposeWithBond);

        const timeLockBalanceBeforeProposeWithBond = await ensToken.balanceOf(timelockController.address);
        expect(timeLockBalanceBeforeProposeWithBond).to.equal(0);

        // Propose with bond
        let proposeTx = await governor.connect(account2).proposeWithBond(
            [account2.address],
            [0],
            ['0x'],
            ''
        );

        // Get proposal details
        const receipt = await proposeTx.wait();
        const proposalId = receipt.events[0].args.proposalId;

        // Cast vote without returning bond
        await ensToken.delegate(owner.address);
        await governor.castVote(proposalId, VoteType.AgainstWithoutBondReturn);

        await mine(1);
        await governor.state(proposalId);
        await mine(VOTING_PERIOD);

        // Refund the proposal and verify bond is saved on timeLockController contract
        const balanceBeforeCancelProposeWithBond = await ensToken.balanceOf(account2.address);

        await expect(governor.connect(account2).refundBond(proposalId))
            .to.be.revertedWith("Bond cannot be refunded");

        await governor.checkAndForfeitBond(proposalId);

        const bondsBalance = await governor.forfeitedBondsBalance();
        const balanceAfterCancelProposeWithBond = await ensToken.balanceOf(account2.address);

        expect(balanceBeforeCancelProposeWithBond).to.equal(balanceAfterCancelProposeWithBond);
        expect(bondsBalance).to.equal(bondAmount);
        expect(bondAmount).to.equal(timeLockBalanceBeforeProposeWithBond.add(bondAmount));
    });

    // Test to verify bond is not refunded when proposal is defeated and AgainstWithoutBondReturn
    it("should not refund bond when proposal is defeated (AgainstWithoutBondReturn)", async () => {
        const account2Balance = PROPOSAL_THRESHOLD;
        await ensToken.transfer(account2.address, account2Balance);
        await ensToken.connect(account2).delegate(account2.address);

        const bondAmount = await governor.calculateBond(TARGETS_COUNT);
        await ensToken.connect(account2).approve(governor.address, bondAmount);

        const balanceBeforeProposeWithBond = await ensToken.balanceOf(account2.address);
        expect(account2Balance).to.equal(balanceBeforeProposeWithBond);

        let proposeTx = await governor.connect(account2).proposeWithBond(
            [account2.address],
            [0],
            ['0x'],
            ''
        );

        const receipt = await proposeTx.wait();
        const proposalId = receipt.events[0].args.proposalId;

        // Cast votes to defeat the proposal
        await ensToken.delegate(owner.address);
        await governor.castVote(proposalId, VoteType.AgainstWithoutBondReturn);

        await mine(VOTING_PERIOD);

        const state = await governor.state(proposalId);
        expect(state).to.equal(ProposalState.Defeated);

        // Check bond is not refunded
        const balanceAfterDefeat = await ensToken.balanceOf(account2.address);
        expect(balanceAfterDefeat).to.equal(balanceBeforeProposeWithBond.sub(bondAmount));
    });

    // Test to verify bond refund when proposal is successful
    it("should refund bond when proposal is successful", async () => {
        const account2Balance = PROPOSAL_THRESHOLD;
        await ensToken.transfer(account2.address, account2Balance);
        await ensToken.connect(account2).delegate(account2.address);

        const bondAmount = await governor.calculateBond(TARGETS_COUNT);
        await ensToken.connect(account2).approve(governor.address, bondAmount);

        const balanceBeforeProposeWithBond = await ensToken.balanceOf(account2.address);
        expect(account2Balance).to.equal(balanceBeforeProposeWithBond);

        let proposeTx = await governor.connect(account2).proposeWithBond(
            [owner.address],
            [0],
            ['0x'],
            ''
        );

        const receipt = await proposeTx.wait();
        const proposalId = receipt.events[0].args.proposalId;

        // Cast votes to pass the proposal
        await ensToken.delegate(owner.address);
        await governor.castVote(proposalId, VoteType.For);

        // Fast forward time to simulate end of voting period
        await mine(VOTING_PERIOD);

        const state = await governor.state(proposalId);
        expect(state).to.equal(ProposalState.Succeeded);

        // Execute proposal
        await governor.execute(
            [owner.address],
            [0],
            ['0x'],
            ethers.utils.keccak256(ethers.utils.toUtf8Bytes(''))
        );
        await governor.refundBond(proposalId);

        // Check bond refund
        const balanceAfterExecution = await ensToken.balanceOf(account2.address);
        expect(balanceAfterExecution).to.equal(balanceBeforeProposeWithBond);
    });

});
