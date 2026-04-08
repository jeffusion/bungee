## [3.2.1](https://github.com/jeffusion/bungee/compare/v3.2.0...v3.2.1) (2026-04-08)


### Bug Fixes

* **release:** gracefully skip already published versions ([6a6d3c5](https://github.com/jeffusion/bungee/commit/6a6d3c599e8de32beb212911d378f828d1c10176))

# [3.2.0](https://github.com/jeffusion/bungee/compare/v3.1.0...v3.2.0) (2026-04-08)


### Bug Fixes

* **model-mapping:** support Gemini URL path model mapping ([6aeef57](https://github.com/jeffusion/bungee/commit/6aeef5772daf395132b874a422127acad37f4af6))
* **plugins:** enforce reasoning_content on assistant tool calls ([c88c481](https://github.com/jeffusion/bungee/commit/c88c481b471a22c54e90d50320ab15de08718ae2))
* **plugins:** fill reasoning_content for array-based tool calls ([b5463f5](https://github.com/jeffusion/bungee/commit/b5463f5d258ee50913343da5c2a8b7e141efd70b))
* **test:** add missing recoveryAttemptCount to mock upstream helpers ([077a60d](https://github.com/jeffusion/bungee/commit/077a60d40f1ef8dbd3fb3d7219ea2cf6ff9a901e))
* **ui:** restore sticky session editor and retry rule validation ([ae44c17](https://github.com/jeffusion/bungee/commit/ae44c170f7b789d3ff74b9e30525eb74b257abd2))


### Features

* **core:** add sticky routing and responses guard ([56a7521](https://github.com/jeffusion/bungee/commit/56a7521001de2a3c8c9c79dceda959cdb9423fc0))
* implement exponential backoff for unhealthy upstream recovery ([af0ad86](https://github.com/jeffusion/bungee/commit/af0ad86af742726de830b5c656f7a4582b8c5dc8))
* **model-mapping:** add standalone plugin and strict row filtering ([950a617](https://github.com/jeffusion/bungee/commit/950a617bd6ed08b70e8650da15359a473f3a6ac5))
* **plugins:** unify OpenAI responses/messages chat compatibility ([3a4fcb1](https://github.com/jeffusion/bungee/commit/3a4fcb179ac4a321d74b60fd293315f11b997ea6))

# [3.2.0](https://github.com/jeffusion/bungee/compare/v3.1.0...v3.2.0) (2026-03-28)


### Bug Fixes

* **plugins:** enforce reasoning_content on assistant tool calls ([c88c481](https://github.com/jeffusion/bungee/commit/c88c481b471a22c54e90d50320ab15de08718ae2))
* **plugins:** fill reasoning_content for array-based tool calls ([b5463f5](https://github.com/jeffusion/bungee/commit/b5463f5d258ee50913343da5c2a8b7e141efd70b))
* **ui:** restore sticky session editor and retry rule validation ([ae44c17](https://github.com/jeffusion/bungee/commit/ae44c170f7b789d3ff74b9e30525eb74b257abd2))


### Features

* **core:** add sticky routing and responses guard ([56a7521](https://github.com/jeffusion/bungee/commit/56a7521001de2a3c8c9c79dceda959cdb9423fc0))
* **model-mapping:** add standalone plugin and strict row filtering ([950a617](https://github.com/jeffusion/bungee/commit/950a617bd6ed08b70e8650da15359a473f3a6ac5))
* **plugins:** unify OpenAI responses/messages chat compatibility ([3a4fcb1](https://github.com/jeffusion/bungee/commit/3a4fcb179ac4a321d74b60fd293315f11b997ea6))

# [3.1.0](https://github.com/jeffusion/bungee/compare/v3.0.0...v3.1.0) (2026-03-26)


### Features

* **plugins:** add openai-messages-to-chat compatibility plugin ([76c0175](https://github.com/jeffusion/bungee/commit/76c01751c27ea5095dde4fab901672739e6631c7))

# [3.0.0](https://github.com/jeffusion/bungee/compare/v2.4.0...v3.0.0) (2026-03-25)


### Bug Fixes

* **ai-transformer:** correct Gemini countTokens request format ([fea0faf](https://github.com/jeffusion/bungee/commit/fea0faf0e235f76a6277cac3e8cc673391fe67f5))
* **ai-transformer:** enforce strict mapping and reactive config visibility ([6ac7afb](https://github.com/jeffusion/bungee/commit/6ac7afb5cf11bcf14bca9681a10d990ce79c0fe0))
* **ai-transformer:** harden tool conversion edge cases ([bcd47c1](https://github.com/jeffusion/bungee/commit/bcd47c15f891f9bf965e78403bf7ea393e498458))
* **ai-transformer:** preserve OpenAI reasoning as Anthropic thinking ([28699be](https://github.com/jeffusion/bungee/commit/28699be476d5e8576b10d63d73f354da19f30ac9))
* **core:** fix plugin isolation for upstreams with identical targets ([afa5d68](https://github.com/jeffusion/bungee/commit/afa5d6825827913ce56d4d5633e72ff55bedfa6d))
* **core:** isolate scoped plugin init config across upstream scenarios ([c90ea9a](https://github.com/jeffusion/bungee/commit/c90ea9a8ae209681524e3d99e0b60020cb91d9fb))
* **core:** prioritize custom plugin resolution and normalize upstream ids ([196982d](https://github.com/jeffusion/bungee/commit/196982d807d5832446db5f09277a603dabaad616))
* **i18n:** add missing common.yes and common.no translations ([0590e07](https://github.com/jeffusion/bungee/commit/0590e07b30c3154b2be910ad6c379a256e7d68c6))
* **plugins:** initialize ScopedPluginRegistry and improve timeline accuracy ([670419f](https://github.com/jeffusion/bungee/commit/670419ffbd33020433ae13660c2219aa07366243))
* **plugins:** isolate upstream plugin scope and refactor token-stats v2.0 ([92d218e](https://github.com/jeffusion/bungee/commit/92d218ee5a4cc823559fd407bd4ef9e2f7d87a4d))
* **plugins:** make anthropic sanitizer fully opt-in and tighten config preview visibility ([1cb78a3](https://github.com/jeffusion/bungee/commit/1cb78a3c8610ec766113942affad632578e7add7))
* **release:** migrate npm publishing to trusted publishing ([f9d5240](https://github.com/jeffusion/bungee/commit/f9d524069d2f5950dffd3e45c0e56680d004cd2e))
* **ui:** track smart-input data files for CI builds ([28251c0](https://github.com/jeffusion/bungee/commit/28251c00c6cd2977f07e54f700be6bc8d195c0fb))
* **upstream:** use array index as upstream runtime identifier ([1d158e2](https://github.com/jeffusion/bungee/commit/1d158e2453596f2a64a27f633683d6511b5a64ec))


### Code Refactoring

* **plugins:** externalize built-in plugins and implement precompiled hooks ([c5886fe](https://github.com/jeffusion/bungee/commit/c5886fef6775fadee1f80890200a710947a52f23))


### Features

* **core:** enhance plugin system with path params, permissions declaration, and UI asset build ([4cb2fab](https://github.com/jeffusion/bungee/commit/4cb2fabea6d2f398a06b08666e790df0b052d9c7))
* **health-check:** add custom headers and query parameters support ([3b1fe33](https://github.com/jeffusion/bungee/commit/3b1fe33cf6af82da80f1ade193f8e7dd83cbf2cd))
* **health-check:** add POST request body support and optimize failover ([ea65813](https://github.com/jeffusion/bungee/commit/ea6581362b93cd43684bc7c075e245bb0ca3ed9a))
* **logs:** persist SSE stream logs and upgrade structured body viewer UX ([530f98f](https://github.com/jeffusion/bungee/commit/530f98f05e22ce158022328c648439ba8591eb97))
* **plugins:** add anthropic filter error tool results plugin ([a656e26](https://github.com/jeffusion/bungee/commit/a656e26f8d15b2c95ddd36ca1ed600f82e20cee4))
* **plugins:** add anthropic tool name transformer with request/response stream fixes ([8b2fea0](https://github.com/jeffusion/bungee/commit/8b2fea07fe26bec5dfa6e2ae497033ad88f8c262))
* **plugins:** add virtual field transform system for dynamic forms ([ed65c97](https://github.com/jeffusion/bungee/commit/ed65c975e5bf7f63897f647012e6e59a4b0b2d0f))
* **ui:** add smart form input component system ([e10137c](https://github.com/jeffusion/bungee/commit/e10137cc87377d86f530db71cfcc983ff4659a1b))
* **ui:** establish comprehensive design system and component showcase ([64134da](https://github.com/jeffusion/bungee/commit/64134dae69948276e197e06c3b2f2b4eb1a1db4b))
* **upstream:** add condition expression support for dynamic upstream filtering ([226f37b](https://github.com/jeffusion/bungee/commit/226f37b49554978eebcaca47f5614ea5498785b2))


### BREAKING CHANGES

* **plugins:** Built-in plugins are now external and must be installed
separately or placed in the plugins/ directory.

# [2.4.0](https://github.com/jeffusion/bungee/compare/v2.3.1...v2.4.0) (2025-12-05)


### Features

* **ui:** add inline editing for upstream priority and weight in modal ([4ca6996](https://github.com/jeffusion/bungee/commit/4ca699607cca63caa968d49edb40d78c5ede179f))
* **ui:** add platform-aware keyboard shortcuts and fix accessibility warnings ([3d88c76](https://github.com/jeffusion/bungee/commit/3d88c7617f3f6c54be4b56831f5720ac023c8996))

## [2.3.1](https://github.com/jeffusion/bungee/compare/v2.3.0...v2.3.1) (2025-12-01)


### Bug Fixes

* **build:** resolve circular dependency in code splitting ([f1c8cfe](https://github.com/jeffusion/bungee/commit/f1c8cfe51983fae852985ee23832dc9562e3311d))

# [2.3.0](https://github.com/jeffusion/bungee/compare/v2.2.0...v2.3.0) (2025-12-01)


### Features

* **core,ui:** add query parameter transformation support ([59d1939](https://github.com/jeffusion/bungee/commit/59d19396e263f63b3213557928f7152b37fe25ec))
* **core:** add dynamic plugin loading support for Docker deployment ([fbcf41d](https://github.com/jeffusion/bungee/commit/fbcf41d3512810b6be0bf275385ae3c2d5106810))
* **ui:** enhance route card UI and fix modal z-index issues ([b304da3](https://github.com/jeffusion/bungee/commit/b304da35fbfd0b997c72920b53ce453e5adea850))
* **ui:** enhance route editor UI/UX with comprehensive improvements ([9b920c4](https://github.com/jeffusion/bungee/commit/9b920c400539a1fd2dc3db820e4a26ff6f4a6231))
* **ui:** merge search and refresh areas into unified responsive action bar ([a2a98c2](https://github.com/jeffusion/bungee/commit/a2a98c23f9b1a219c5ab86c87370985df37fcd2a))
* **ui:** refactor logs page filter UI to dropdown + chips design ([b7d4d86](https://github.com/jeffusion/bungee/commit/b7d4d8646fbd7e31ad730d6720d701fb7d65e1f1))

# [2.2.0](https://github.com/jeffusion/bungee/compare/v2.1.0...v2.2.0) (2025-11-25)


### Bug Fixes

* **ui:** fix chart sync race condition on page navigation ([912113e](https://github.com/jeffusion/bungee/commit/912113e8605a62fa27f73ae9bfbfe6f56244166b))
* **ui:** improve chart grid visibility in light mode ([76fd164](https://github.com/jeffusion/bungee/commit/76fd164d8bc4bd5da2eb790ef8bb56b9befdd5c0))


### Features

* **ui:** add chart synchronization and improve no-data display ([b07e8e9](https://github.com/jeffusion/bungee/commit/b07e8e94b6501fb8671827b6fa5aa9332411cae9))
* **ui:** add unified upstream stats API and improve chart interactions ([8b09a9c](https://github.com/jeffusion/bungee/commit/8b09a9c4a6cd424d6f3eff57d050f14f896d43b4))

# [2.1.0](https://github.com/jeffusion/bungee/compare/v2.0.0...v2.1.0) (2025-11-12)


### Features

* **ci:** optimize CI workflow and add binary release support ([ebf9bb6](https://github.com/jeffusion/bungee/commit/ebf9bb6fc831eb775c92098dcc03cb542c44c96a))
