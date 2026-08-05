# Smile Dataset Research Notes

Working labels: `reward`, `affiliative`, and `dominance` smiles. These should remain working names until Randy confirms the final taxonomy.

| Dataset / resource | Labels available | Media type | Access process | Licensing / use concerns | Usefulness |
| --- | --- | --- | --- | --- | --- |
| [Shades of Smiles](https://link.springer.com/article/10.1007/s00426-026-02263-z) | Targets reward, affiliative, and dominance smile categories directly | Face stimuli / experimental smile set | Request full stimuli and terms from the authors | Confirm permission for model training, redistribution limits, and whether identity-separated splits are allowed | Best lead because it matches the exact subtype goal |
| [Functional Smiles](https://pmc.ncbi.nlm.nih.gov/articles/PMC6056899/) | Theoretical and stimulus-design framework for reward, affiliation, and dominance smiles | Paper / stimulus framework | Public paper; contact authors if stimuli are needed | Useful for definitions, not automatically a reusable training dataset | Strong guide for labeling protocol and prompts |
| [Dynamics Matter](https://pmc.ncbi.nlm.nih.gov/articles/PMC6004382/) | Evidence that dynamic smile sequences improve recognition of smile meaning | Paper / dynamic stimuli framework | Public paper; contact authors if stimuli are needed | Clarify reuse rights before model training | Useful for deciding to collect short clips instead of still images only |
| [AffectNet](https://mohammadmahoor.com/pages/databases/affectnet/) | Broad affect categories and facial expression labels | Images / some updated annotations | Apply through dataset owner process | License limits and label mismatch with smile subtype goal | Useful for auxiliary pretraining, not direct subtype classification |
| [DISFA](https://www.mohammadmahoor.com/pages/databases/disfa/) | Facial action unit intensity labels | Video | Apply through dataset owner process | AU labels do not equal reward/affiliative/dominance smile labels | Useful for feature pretraining or AU sanity checks only |
| [DISFA+](https://mohammadmahoor.com/pages/databases/disfa_plus/) | Expanded DISFA-style AU and expression resources | Video / images | Apply through dataset owner process | AU/expression labels still do not directly solve subtype labels | Useful as support data, not final classifier labels |

Recommended next steps:

1. Request Shades of Smiles access and ask whether the stimuli can be used for internal classifier training.
2. Ask for subject IDs or split guidance so validation can be person-separated.
3. Use Functional Smiles and Dynamics Matter to design our own prompted clip collection protocol.
4. Treat AffectNet, DISFA, and DISFA+ as auxiliary resources only unless subtype labels are added by reviewers.
5. Keep the first model evaluation conservative: person-separated validation, confidence thresholds, and an explicit `uncertain` output.
