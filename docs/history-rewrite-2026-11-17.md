# History rewrite of 17 November 2026

On 17 November 2026, at the author's word, every commit of OpenAssess up to this point was rewritten so that it holds to the rules in
`CLAUDE.md` ("Commits, tags and releases"): each is now made as `jasonswrench-beep <324576087+jasonswrench-beep@users.noreply.github.com>`, and
the `Co-Authored-By` lines are gone. Nothing else changed: every commit has the same files, the same author and commit dates and the same
parents as before, and the 26 release tags were moved to the new commit of the one they named. Two messages that cited another commit
cite its new hash.

A hash written before that day (in a release's notes, in another repository, in a message or a chat) names an old commit. This table
gives the new commit for each old one, in the order they were made.

| Old | New | Subject |
|---|---|---|
| `e106d3a` | `a577f81` | Phase 1: the question model, the bank container, and the read contract |
| `c940f9b` | `e92c2dc` | Add CLAUDE.md with the conventions that are easy to break |
| `d107ab3` | `3ba3f4c` | Rewrite the Standard Format scanner as an explicit mode machine |
| `eddcea4` | `d62d430` | Make the importer emit only schema-valid questions |
| `2e6ed6c` | `a16fa28` | Make hasUsableKey refuse a key that names a missing option |
| `647f1e2` | `0c555ef` | Read the the test-bank vendor dialects, fix repeated answer numbers, and record the design plan |
| `95a122b` | `a146e41` | Add the first exporter: the question spreadsheet for Author and Scroll |
| `655532e` | `261035a` | Plan the Word import engine |
| `12a9b83` | `474c7fe` | Add the first slice of the Word importer |
| `d3c05f9` | `a0c79de` | Read Word's own list numbering |
| `6e6ab94` | `bb9abfb` | Read answer keys from Answer lines and from formatting |
| `4cbc0ce` | `d215170` | Stop explanations and other labels joining the option above them |
| `7035b1d` | `5a1a483` | Read questions laid out in Word tables |
| `e9ece5a` | `baf5de3` | Read a publisher's own layout: a table for each question, a table for each option |
| `041b525` | `4b0e1b4` | Read a key typed after the option letter, when the whole file does it |
| `98bf7b7` | `d47b61e` | Read three more of one instructor's banks: page notes, dotted numbers, lone letters, matching tables |
| `f8e1bbd` | `1093468` | Read a publisher's layout and a second chapter, found by a blind test |
| `745961e` | `4607f31` | Read a bank with no numbers or letters, found by a blind test on open files |
| `4717026` | `910b8a7` | Read a type from the answer or the pairs, found by a blind test on a generated batch |
| `b5d760f` | `9c11172` | Hold a generated test bank to its plan before the importer sees it, and fix the cmd test list |
| `17d08af` | `9348532` | Say what differs when a generated file fails the check, and correct the brief on spacing |
| `7b8e429` | `739c9a3` | Count a repeated question by its stem and its items, and record the first blind run on sixteen generated files |
| `3d82727` | `6ef1f11` | Split options that share a paragraph on a wide gap, and flag a choice question whose option letters have a gap |
| `9ae2675` | `74235b1` | Read keys at the end, types from answers, banks with no labels, bulleted options and (T)/(F) statements |
| `41d9c93` | `4f8535f` | Add a review page for an import, and leave hidden text out of what is read |
| `56b00ae` | `aa0ea1a` | Add the app: a local server and the screens for import review and banks |
| `8002d23` | `0592101` | Read Aiken and GIFT, and write GIFT and Moodle XML |
| `7b65ab3` | `5813bd5` | Add the export screen, and a title only when someone wrote one |
| `45066a2` | `51eece8` | Print a bank as a test: a student copy and an answer key, as Word and PDF |
| `bd111ad` | `f49a8f5` | Let the window open the app: hand the key over in a page, log requests, and hide the content focus ring |
| `df090d6` | `87d176e` | Add the OpenAssess window: a Tauri shell around the app's local server, and a browser launcher |
| `ec6097c` | `c0cd0b0` | Record the app and its window in the plan, the findings and the list of checks only a person can make |
| `16fb9a6` | `247996f` | Read a list of questions from Excel or CSV, in the columns OpenStage Author reads |
| `91db382` | `59cc232` | Bring in Excel and CSV files in the app, offer four samples, and refuse a PDF with the way in |
| `d372fae` | `67ac93f` | Record the question table importer, why a PDF is refused, and what a person still has to check |
| `49ffa1d` | `728eeaa` | Read an Answer line as letters only when it is all letters or its letter and words agree |
| `322db71` | `540f5f8` | Read a PDF from its text, with no library, through the same scanner as a Word file |
| `d050dac` | `2a56915` | Bring a PDF into the app, and name its page on the review screen |
| `44bfea2` | `7f87b53` | Record how a PDF is read, what the first real ones taught, and what a person still has to check |
| `547aa57` | `312ee53` | Export to Brightspace's Question Library as a CSV, with the destination check |
| `c5e0481` | `a5d3b50` | Make Show in folder open the right folder, and give an exported file a Save dialog |
| `2930b36` | `7c56666` | Record the first real import of a Brightspace file, and what it did not show |
| `d204c06` | `3161fe4` | Show the system's Save dialog when the window downloads one of the app's files |
| `5163807` | `64eed0f` | Ask where to put a sample, the way an export does, instead of writing it into Exports |
| `21f5d6e` | `01e66e1` | Keep each printed question on one page |
| `8851f0e` | `0579b02` | Let an answer chosen by hand replace what the file's key said |
| `dd72d7f` | `aa2aab6` | Record what a person has now seen working in the window |
| `2f123e6` | `16070f3` | Let words written over a placeholder replace the error about it |
| `77e191a` | `e8bc05b` | Export a QTI 1.2 package for Brightspace and Canvas, and a Blackboard upload file |
| `98c3172` | `ca5470a` | Give the setup file and the uninstaller the OpenAssess icon |
| `0f88990` | `483a299` | Record the second Brightspace CSV import, and what it does not show |
| `d63474b` | `2611d87` | Point the Brightspace QTI note at the route that reads QTI, and record the first try |
| `e80cb04` | `50e23da` | Export a Common Cartridge 1.3 package for Brightspace, in the form a Brightspace quiz tool writes |
| `dcd9a36` | `867c129` | Put the official Apache License 2.0 text in LICENSE |
| `8e42adf` | `4387472` | Take the names of two institutions out of the design plan |
| `7cbd4b9` | `3526a1b` | Add the paper tests specification to docs |
| `1a39226` | `0b0c2b4` | Add public roadmap and feature request link |
| `1ce1ea7` | `f064cf2` | Record the decisions on the paper tests spec and write its six phases |
| `9a95590` | `2a7bf15` | Phase 0 of the answer sheets: assembled tests with versions, and booklets and keys for each |
| `0963996` | `475343e` | Phase 1 of the answer sheets: geometry, the code strip and the printed sheet |
| `dbb7657` | `5034e67` | Phase 2 of the answer sheets: the reader, its accuracy gate and Check my printing |
| `c4dc576` | `6d7435a` | Phase 3 of the answer sheets: scans in, from PNG and from PDF, and checks on a batch |
| `74d6da7` | `0d98037` | Phase 4 of the answer sheets: scoring, adjustments, item statistics, and what is kept |
| `293961d` | `fb66fff` | Phase 5 of the answer sheets, the server: tests, paper, scoring, review and what is written |
| `c7254ec` | `a7b0aae` | Phase 5 of the answer sheets, the screens: assemble, print, check, score, review, results |
| `c0600fe` | `eefffdf` | Describe product capabilities without external comparisons |
| `29adc27` | `1a61141` | Check quality: notes on the writing and accessibility of questions, copies, and where the right answers sit |
| `a566e78` | `337d6ac` | Describe the test-bank format without naming a commercial product |
| `0dc3674` | `ea06381` | Search finds accented words in any script, and the index builds in linear time |
| `8036fa7` | `6aadb6a` | Fix five small defects from the open list, and guard the double-click check against dropping a test |
| `9d433cc` | `34715e6` | Coverage: what a bank covers, as a grid, and narrowing a list by chapter, objective, tag and more |
| `0ab411e` | `2aa18a4` | Pick for me: choose some questions by chapter, objective, tag and more for a test, at random |
| `cb00e28` | `1bce354` | Say what a bank could not read, keep a damaged question file through a save, and keep a matching error |
| `ca5c27e` | `52dae51` | Keep a damaged folder file instead of refusing the bank or replacing it with nothing |
| `79992ab` | `418eb19` | Keep the headings of the home and review screens in order for a screen reader |
| `a150073` | `6b38b4f` | Fuzz the readers with damaged files, and fix the two crashes it found in the bank reader |
| `de8dfad` | `4ee9496` | Take out the characters a file format forbids, so one stray character cannot make an LMS refuse a whole file |
| `65d21bc` | `b0b7f98` | Hold GIFT and the question spreadsheet to coming back the same |
| `baa3b47` | `edf4618` | Record that the whole of Check OpenAssess.cmd was run, and the test counts |
| `f47ec7b` | `c1397b0` | Hold a printed test to what a printed test is, by reading the printed files back |
| `3b4a025` | `a7cddc5` | Fix what a second read of the quality checks, search and bank code found |
| `fd407e0` | `cba13bf` | Add folders to the bank screen |
| `1ed6631` | `59c0970` | Say that a zip was cut short, and do not read a fake end record in a comment |
| `c84c9ed` | `eeb01c2` | Let an import be saved into a folder |
| `7658419` | `20d46f2` | Describe each tool on its own terms, not against other software |
| `381006c` | `b1cdaf1` | Keep the author's typography instead of flattening it |
| `a6ef8ab` | `b4c3932` | Keep the pictures in a Word file |
| `879e2ea` | `973cd2c` | Print and carry pictures, and fix two faults real Word found |
| `8e120ea` | `700df32` | Add a picture by hand, read Word's decoration mark, and file several questions at once |
| `d41c2eb` | `dd6e2f7` | Read symbols and equations from Word files |
| `cb4a4db` | `49d858d` | Show equations in the app, print them as Word equations, write them to Moodle |
| `e6af521` | `e69e033` | Keep a tracked insertion in the copy of an equation, and hold the MathML to the window's list |
| `993f07b` | `831df8c` | Flag the question that holds a picture, equation or symbol the reader could not read |
| `666dc54` | `7dc4a8b` | Draw Greek letters and signs of mathematics in the PDF with its built-in Symbol font |
| `c7a6702` | `daa0057` | Flag the question that has a data table inside its text |
| `70d79cc` | `0540cc4` | Say plainly which letters and signs the PDF check looked at |
| `ac44438` | `b1f80f5` | Keep a data table inside a question as a table |
| `5e11f51` | `7bbdd8f` | Print a table of a question's stem as a table in the Word file |
| `cda0884` | `9f412e0` | Keep a stored recipe for a test in the bank |
| `f40f46f` | `650c4e7` | Use a stored recipe for a test in the app and on the command line |
| `0b92eeb` | `2c97b90` | Write a QTI 2.1 package: a file for each question in XHTML, scored by its own response processing |
| `3218991` | `f9ed72e` | Read a Moodle XML file, with the key it gives and none it does not |
| `3f13d67` | `4f6385a` | Read a QTI package or file, 1.2 and 2.1, with the key its scoring states and none it does not |
| `939e996` | `6c667c1` | Stop the editor writing the word null above an essay's model answer, and test the new file types through the app |
| `b229544` | `9613a8d` | Hold the new importers to the real banks, and read a package of any size a zip can hold |
| `f6d781e` | `8594048` | Say exactly how many real questions were compared |
| `00017a3` | `96576b2` | Let a blueprint rule ask for values on more than one axis, such as chapter 2 and the apply level |
| `851aebd` | `2d533b2` | Read a question library from Brightspace, and a Common Cartridge file, which the QTI reader had never met |
| `785b52d` | `e74e392` | Record what the first real Brightspace file showed, and rules that name a cell of the test plan |
| `b2df326` | `64da82a` | Read a table that gives the right answer in a column of its own, and say what a zip of other files holds |
| `403f624` | `b58b6af` | Hold the newer readers to the damaged-file rule: QTI and Common Cartridge packages, a Brightspace-shaped library, a right-answer-first table |
| `446e88d` | `ecd3efe` | Say what a file is when it is of a kind this does not read, and what to do instead |
| `3379172` | `1bf4a20` | Name the question dialog by its heading, and record what the screens were checked for |
| `144e6f0` | `03b8ce3` | Read answer columns named by number, with a number in the Correct column |
| `d018985` | `41ea822` | Read the columns a bank is organised by from a question table, and the names tables give their columns |
| `b1d5adb` | `6aaa18f` | Write a multiselect's all-or-nothing scoring as the token the importer is reported to read |
| `7aa528d` | `1328f08` | Read a Brightspace question library CSV, so the file this program writes for Brightspace comes back |
| `595fc28` | `b8af5d2` | Do not take a column called Item for the question column |
| `39e82a0` | `15fdcc7` | Fix what an independent review proved in the table and Brightspace readers |
| `9064b3b` | `11232ef` | Name controls for what they are for, and speak confirmations from a region that stays in the page |
| `0314e4e` | `a43e6b4` | Do not call two questions alike when both their stems and their right answers differ |
| `651bed1` | `d568e54` | Look for a negative stem in the question, not in the story, a quotation or a condition |
| `d8679d1` | `4cb1cab` | Keep the capital that carries the meaning when judging whether two options are copies |
| `6e78d57` | `fc4031a` | Show the chosen filter, row, bubble and drop target in Windows high contrast |
| `8d0991c` | `9f1450e` | Record what was looked at on 7 November: the review page in dark colours and a printed PDF with pictures |
| `1c2f06d` | `64f2a2e` | Say that numbers repeat as information, not a warning, when no answer was held back |
| `eafc6b4` | `18dfcbb` | Say that a game board's Value column was not used as information, not a warning |
| `9f6936a` | `22ca3d4` | Choose a question in a long list without drawing the whole list again |
| `ac113de` | `22b863b` | Fix what an independent review of the alpha 12 changes proved |
| `873391f` | `2aedab2` | Draw the first thousand rows of a long list, and say how many are not drawn |
| `aab6d83` | `7801e19` | Look for questions that are alike only among those with the same numbers |
| `44b9fd9` | `2813d21` | Take a numbered running title off the pages of a PDF, as it is not a question |
| `b1c836b` | `4b2d420` | Say what Word's lock file and a file that is too large are, in words |
| `08f577d` | `8a5bf76` | Offer Show all only for a list of 5000 or fewer |
| `b60c856` | `15b89b9` | Say once, for a file, that it may not be a test bank when every question is a guess at an essay |
| `f352437` | `d8240ac` | Read Blackboard's upload file, so the file this program writes for it comes back |
| `f4af968` | `bd605f1` | Read a question table whose column names carry a description |
| `3dc5edf` | `9d58ba7` | Say that the answers of a question were mixed, not was |
| `975c48b` | `d8ad7e7` | Say in the testing list what to look for in a real Blackboard file |
| `167d92b` | `9771a56` | Record what real key presses did in the score review and at the end of a long list |
| `964ebc5` | `f059efa` | Make the home screen's file choosers reachable by keyboard |
| `5058426` | `9a31c38` | Fix six faults an independent reader proved in the Blackboard reader and the header rule |
| `0020ab0` | `7f39c3c` | Fix seven faults a second reader proved in the fixes for the first |
| `83db841` | `3101ae2` | Fix four faults a third reader proved in the second round of fixes |
| `dbc5be3` | `65fae22` | Fix five faults a fourth reader proved around the Blackboard reader and the table reader |
| `f8b7d69` | `bc69fc0` | Fix what a round trip of random questions through the exporters found |
| `fcca362` | `6ce1d37` | Fix what a fifth reader and a tester of pictures, equations and fields found |
| `217b343` | `47797c6` | Fix what a security method and an interface method found when tried on the whole app |
| `fa68710` | `ecd56a5` | Fix what two readers of the alpha 20 fixes found, and the same kind of fault around them |
| `ba97ac3` | `9a745dd` | App and tooling fixes from the third round of readers |
| `c387b34` | `14adfa4` | Fix what readers proved in the bank store, the quality checks and the file names |
| `822f89b` | `4f2658a` | Merge the banks, quality checks and file names fixes |
| `e803a68` | `08f5471` | List the new test files in the check script; the app-side planted faults |
| `9cfd349` | `9d3fa2e` | Tests that read the interface's source no longer depend on its line ends |
| `296005a` | `4ebf21c` | Stop the Word and spreadsheet readers trusting a count, a step or a repeated word in the file |
| `3653e40` | `af8dbbc` | Merge the Word and spreadsheet reader fixes |
| `c536cdd` | `92972fa` | List the Word and spreadsheet test files in the check script |
| `eb9f7ff` | `b5cab33` | Fix the readers and writers that cost far more than the file is long, and the calls that fail at about 125,000 arguments |
| `9e37c56` | `4a7a376` | Merge the regex, spread and reader fixes |
| `9d8d449` | `c80a9f1` | List the readers' test files in the check script |
| `e2d536e` | `3cc8e9d` | Fix what a third reader of the PDF reader and the zip reader proved, and the same kind of fault beside it |
| `4facf65` | `c8d96de` | Merge the PDF and zip reader fixes |
| `5384ff5` | `38519b3` | Show what a check could not do in full, and the documents for alpha 22 |
| `cbaf374` | `708ea9c` | Test counts for alpha 22 |
| `7e4a35f` | `4c7c11a` | Findings: the number of planted faults is 258 |
| `21d5e0e` | `ab46fbb` | Fix what the fourth reader of the Word, Excel and bank fixes proved |
| `58056ce` | `8c20291` | Claim a bank's name by a link, and fix the faults a fourth reader proved in the app |
| `7facc70` | `dce4eb3` | Hold the claim by a link with 65 planted faults, and make the smoke script run from source |
| `89741b4` | `2a5bbd6` | Name the app's five new test files in the double-click check |
| `e77cc1c` | `a86e8c5` | PDF reader: read objects whole again, bound table objects, keep font widths, pin real-file behaviour |
| `92caeda` | `87ffdd1` | Fix what the fifth reader proved in the scanner, small formats, quality check, spread guard, PNG budget and findings cap |
| `4d98e4c` | `11ed832` | Take the stale spread-guard entry out, name the PDF test files in the double-click check, and correct the names paragraph |
| `9cb2218` | `8bb9461` | Make the fault runner stop on a signal, refuse to say "caught" when it planted nothing, and wait for a run in its own checkout |
| `7453f00` | `5a3d2ba` | Take the entries for replaced code out of the fault lists, and the documents for the fourth round |
| `248d668` | `044feb7` | Plant eleven faults in the scanner, small-format, quality and cap fixes, and hold the cap to not cutting twice |
| `9b27fb3` | `66ab5e1` | Check alpha 23's fixes in the smoke script, and say in the findings what was run |
| `d6fb537` | `ceebc3c` | Findings: the fourth round's fixes are in alpha 23 |
| `c3049f8` | `e17f1c2` | Ignore local AI-assistant files and credential files |
| `76e1896` | `6c96af3` | Make the fault runner count tests in TAP, so it works on the Node GitHub runs |
| `85190a6` | `070ee52` | The OpenStage suite's look: a navy bar, menus, the command search and the keys |
| `3e7f3cd` | `f47c8f0` | Fix what the accessibility audit found on the screens |
| `8029f35` | `bed2d76` | Release checks for alpha 24: a fault list for the suite's look, and a test it showed was missing |
| `e2009de` | `8c5a440` | Security fixes from the release review, and Check for updates (0.1.0-alpha.26) |
| `a4c7097` | `5653f60` | Fixes from a test of alpha 26 (0.1.0-alpha.27) |
| `7076a1a` | `41ed566` | Set the fill lines on real paper, and hold the item statistics to R |
| `1ebc06e` | `36d7c23` | Write the class's results as a .pstat file for PrismStatistics |
| `d3e713c` | `99d5d01` | Read a learning system's quiz results into the same item statistics |
| `3ba6868` | `f36a1c3` | Read each question's figures back across classes, and note the ones to revise |
| `7bb69b9` | `6ff9827` | Export and read QTI 3.0, and keep a matrix of real imports per system |
| `cb68b30` | `9e9f9a7` | Say what items 7 to 9 wait on in the shared core |
| `0c7ca94` | `71288fb` | Set the fill lines on real paper in the app, and write the core handoff |
| `1159888` | `23563f2` | Design plan and smoke checks for this round's work |
| `2a2b317` | `7490dc6` | Planted faults for alpha 28's new code |
| `ca56055` | `734ac9c` | Fix what an independent review of this round proved |
| `c54036b` | `1200727` | Release alpha 28 |
| `20cfca1` | `2e27b70` | Name the .pstat questions by their number on version A, as PSTAT-1 1.1 settles |
| `2039a7a` | `47b89a4` | Write the .pstat in profile 2: the letters marked, and every question's key and details by bank id |
| `ea91c0e` | `3d31bb0` | Fix what a review of profile 2 proved, and check the key before writing it |
| `3f3f2d3` | `81182b0` | Print boxes for short answers on the answer sheet, and score them by hand |
| `d1ef945` | `396aeae` | Release alpha 29 |
| `1496885` | `0301137` | Record the rules for commits, tags and releases |
| `d7d572e` | `e3ad318` | Say that GitHub refuses a release tag being moved or deleted |
