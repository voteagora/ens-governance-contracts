// SPDX-License-Identifier: MIT
pragma solidity ^0.8.2;

import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./ENSGovernor.sol";

/**
 * @title ENSGovernorV2
 * @dev Enhanced ENS Governor with bonding functionality.
 */
contract ENSGovernorV2 is ENSGovernor {
    using SafeERC20 for ERC20Votes;

    uint256 public forfeitedBondsBalance;
    uint256 public lockedBondsBalance;

    /**
     * @dev ProposalBond represents the bond associated with a proposal.
     */
    struct ProposalBond {
        uint256 amount; // The amount of bond deposited.
        address proposer; // The address of the proposer who deposited the bond.
        bool refunded; // Flag indicating if the bond has been refunded.
        bool forfeited; // Flag indicating if the bond is forfeited.
    }

    /**
     * @dev Mapping to store ProposalBond objects associated with proposal IDs.
     */
    mapping(uint256 => ProposalBond) private _proposalBonds;

    /**
     * @dev Emitted when a bond is created.
     * @param proposer The address of the proposer.
     * @param amount The amount of bond.
     */
    event BondCreated(address indexed proposer, uint256 amount);

    uint256 public bondPricePerTarget = 1 ether;

    /**
     * @notice Constructor to initialize the ENSGovernorV2 contract.
     * @param _token The token used for voting.
     * @param _timelock The timelock controller.
     */
    constructor(
        ERC20Votes _token,
        TimelockController _timelock
    ) ENSGovernor(_token, _timelock) {}

    /**
     * @notice Propose a governance action with a bond.
     * @param targets The addresses to call.
     * @param values The values to send.
     * @param calldatas The calldata to send.
     * @param description The description of the proposal.
     * @return proposalId The ID of the proposal.
     */
    function proposeWithBond(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public returns (uint256 proposalId) {
        // Transfer bond to the contract
        uint256 bondAmount = calculateBond(targets.length);

        // Create the proposal
        proposalId = propose(targets, values, calldatas, description);

        token.safeTransferFrom(msg.sender, timelock(), bondAmount);
        createBond(proposalId, bondAmount);
    }

    /**
     * @notice Calculate the bond amount based on the count of targets.
     * @param countOfTargets The number of targets in the proposal.
     * @return The calculated bond amount.
     */
    function calculateBond(
        uint256 countOfTargets
    ) public view returns (uint256) {
        return countOfTargets * bondPricePerTarget;
    }

    /**
     * @notice Create a bond for a proposal.
     * @param proposalId The ID of the proposal.
     * @param bondAmount The amount of bond.
     */
    function createBond(uint256 proposalId, uint256 bondAmount) internal {
        lockedBondsBalance += bondAmount;

        _proposalBonds[proposalId] = ProposalBond({
            amount: bondAmount,
            proposer: msg.sender,
            refunded: false,
            forfeited: false
        });

        emit BondCreated(msg.sender, bondAmount);
    }

    /**
     * @notice Refund the bond for a proposal if conditions are met.
     * @param proposalId The ID of the proposal.
     */
    function refundBond(uint256 proposalId) public {
        ProposalState status = state(proposalId);
        require(
            status != ProposalState.Pending && status != ProposalState.Active,
            "Wrong proposal status"
        );

        (uint256 againstVotesWithoutBond,uint256 againstVotes,,) = proposalVotes(proposalId);

        require(
            againstVotes >= againstVotesWithoutBond,
            "Bond cannot be refunded"
        );

        ProposalBond storage bond = _proposalBonds[proposalId];

        require(bond.proposer != address(0) , "Bond is not active");
        require(!bond.refunded, "Bond is refunded");

        token.safeTransferFrom(timelock(), bond.proposer, bond.amount);
        lockedBondsBalance -= bond.amount;
        bond.refunded = true;
    }

    /**
     * @notice Check if we can forfeit bond of the proposal
     * @param proposalId The ID of the proposal.
     */
    function checkAndForfeitBond(uint256 proposalId) public {
        ProposalState status = state(proposalId);
        require(
            status != ProposalState.Pending && status != ProposalState.Active,
            "Wrong proposal status"
        );

        (uint256 againstVotesWithoutBond,uint256 againstVotes,,) = proposalVotes(proposalId);

        require(
            againstVotes < againstVotesWithoutBond,
            "Bond cannot be forfeited"
        );

        ProposalBond storage bond = _proposalBonds[proposalId];

        require(bond.proposer != address(0) , "Bond is not active");
        require(!bond.forfeited, "Bond already forfeited");

        lockedBondsBalance -= bond.amount;
        forfeitedBondsBalance += bond.amount;
        bond.forfeited = true;
    }
}
