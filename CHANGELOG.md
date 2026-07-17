# [4.3.0](https://github.com/jeffusion/bungee/compare/v4.2.0...v4.3.0) (2026-07-17)


### Bug Fixes

* **ci:** start Vite dev server before Playwright smoke tests ([76d470d](https://github.com/jeffusion/bungee/commit/76d470d71f3b8926c8093a8c1ae93ea5701bf170))
* **core:** chain stats tests now call production LogQueryService ([738c9de](https://github.com/jeffusion/bungee/commit/738c9de77cf82b813c55912754372cfb29aeb934))
* **core:** restore passive health recovery path broken by healthFilter ([6eac9a6](https://github.com/jeffusion/bungee/commit/6eac9a6eb585ca658139af23447eb883f471149b))
* **failover:** simplify retry_on_response to keyword list; fix remove button ([19f59b1](https://github.com/jeffusion/bungee/commit/19f59b133fda02922163457a1a9f4b40dd0b6654))
* **ui:** break effect_update_depth_exceeded loop in BasicInfoSection path_rewrite sync ([0f2dcba](https://github.com/jeffusion/bungee/commit/0f2dcbab05b779c7bb462718ff2d69f9c2dd94cf)), closes [#4402](https://github.com/jeffusion/bungee/issues/4402)
* **ui:** bselect default full-width, route filters opt-in autoWidth ([4cb92ea](https://github.com/jeffusion/bungee/commit/4cb92ea6777c12e7c286eb56b7eddada5f7d7c78))
* **ui:** chain list status display + flattened attempt detail nesting ([0a2f9b8](https://github.com/jeffusion/bungee/commit/0a2f9b83ee9a9461c3de10132dcd73741a079404))
* **ui:** dashboard upstream status chart — horizontal layout, industrial styling, overflow scroll ([411da7d](https://github.com/jeffusion/bungee/commit/411da7da14c191631c6887ebf6b1cd3a383c3716))
* **ui:** raise BSelect dropdown z-index so it renders above z-[100] modals ([c7e7f38](https://github.com/jeffusion/bungee/commit/c7e7f38e40061395796098856b1afbd627f9636b))
* **ui:** route modification editors fail to load existing data ([963cbb7](https://github.com/jeffusion/bungee/commit/963cbb7cf535a5e6357b8d185007191816a8e467))
* **ui:** stabilize BSelect single-mode width via ghost span (4th regression) ([217ea7c](https://github.com/jeffusion/bungee/commit/217ea7cd6aba1449f2f1787b79dc769c70b1c571))


### Features

* **api:** expose /api/stats/upstreams/last-used endpoint ([05be232](https://github.com/jeffusion/bungee/commit/05be23249f2772d7e63589ad4b4f539c1b59dfe7))
* **core,ui:** failover bug fixes + health_check extraction from FailoverConfig ([10f7fb4](https://github.com/jeffusion/bungee/commit/10f7fb42ce06a1e046f9a3baed9bbd358456a488))
* **core,ui:** split load balancing policy into strategy-pattern selector ([ed08ec8](https://github.com/jeffusion/bungee/commit/ed08ec8d8edbea74be579cbee80c3fa25f73882a))
* **core:** add chain aggregation to LogQueryService ([ad16ab3](https://github.com/jeffusion/bungee/commit/ad16ab386c7f2f20a33d1d343b52d5d0571ff1ce))
* **core:** add retry_on_response failover based on response body content ([44e3ffb](https://github.com/jeffusion/bungee/commit/44e3ffba7ee91e41d52d23e3b269525718165419))
* **core:** switch dashboard stats to chain dimension ([f4709ff](https://github.com/jeffusion/bungee/commit/f4709ff32656bb36f18b48f81bdd317d3314534e))
* **core:** track per-upstream last_used_time in runtime-state ([ffb13f5](https://github.com/jeffusion/bungee/commit/ffb13f57527b2cca2a96ab7627c56c31f69c21c1))
* **ui:** add 'last used' column to service endpoints drawer ([0d8cec0](https://github.com/jeffusion/bungee/commit/0d8cec072c6496559ea9e21817852552e63b3be1))
* **ui:** add chain dimension tooltips to dashboard KpiCards ([2808e86](https://github.com/jeffusion/bungee/commit/2808e864dac8d827c02c826e112f8f8fc643abdb))
* **ui:** add retry_on_response rules form to FailoverEditor ([79a3eb1](https://github.com/jeffusion/bungee/commit/79a3eb1bdd70655f255f0b78ef7b43f7413765e7))
* **ui:** chain aggregation view in request logs ([64e6137](https://github.com/jeffusion/bungee/commit/64e6137a588c265695c606ee66d496435efcc06e))

# [4.2.0](https://github.com/jeffusion/bungee/compare/v4.1.0...v4.2.0) (2026-07-06)


### Bug Fixes

* **build:** track industrial/data/ to fix CI UI build failure ([42ee521](https://github.com/jeffusion/bungee/commit/42ee5219d385ac38aaccb934be56a9c0058bd804))
* **ui:** adapt JsonBodyViewer theme tokens to industrial dark ([45f8469](https://github.com/jeffusion/bungee/commit/45f84695fc85a5cdf9cc987aef01d52348d2c767)), closes [#fb923](https://github.com/jeffusion/bungee/issues/fb923)
* **ui:** add nx-btn-md size variant to unify toolbar element heights ([fbe5a84](https://github.com/jeffusion/bungee/commit/fbe5a847a02d44ae372fb40a3f7c46d7d65da1f8))
* **ui:** drop redundant left border on LoggingEditor body subform ([8e43d93](https://github.com/jeffusion/bungee/commit/8e43d93427c3fb4c2c5702e26f61d724ae94d7eb))
* **ui:** enable plugin toggle persistence and use default-size switch ([025aa7f](https://github.com/jeffusion/bungee/commit/025aa7f5871561911c26e4ab240bf89d2c700761))
* **ui:** enlarge log detail body viewer area ([0f0e786](https://github.com/jeffusion/bungee/commit/0f0e7862f3365985b35964b10690da4bccfab69d))
* **ui:** forward BSwitch newChecked and per-plugin processing guard ([2b556e7](https://github.com/jeffusion/bungee/commit/2b556e7de9aadcbd6706b0152a20677708e1e408))
* **ui:** make sort selects responsive with flex-wrap in Logs filter panel ([d2c1747](https://github.com/jeffusion/bungee/commit/d2c174719b6ebe225673cdff0e54170bf90b2b8a))
* **ui:** remove svelte-jsoneditor internal borders from JsonBodyViewer ([91f43d9](https://github.com/jeffusion/bungee/commit/91f43d94d9dab84b5100f0627f818502dec5f217))
* **ui:** replace all DaisyUI CSS dropdowns with Bits UI DropdownMenu ([56d7470](https://github.com/jeffusion/bungee/commit/56d7470408f417d9ecea53f3e61cb5329184169f))
* **ui:** rewrite NxSelect with Bits UI to fix nested dropdown conflict ([3e62f46](https://github.com/jeffusion/bungee/commit/3e62f46288ecb79f5bb5dd4df4f5d1e076da785f))
* **ui:** satisfy migration guards ([ac32eec](https://github.com/jeffusion/bungee/commit/ac32eeca32985b99b464a7fbaf7fb9e13cea80a5))
* **ui:** set min-height on log detail modal content area ([cf395a6](https://github.com/jeffusion/bungee/commit/cf395a6856394f93040c46a41e5e0b4e0a83300f))
* **ui:** unify Configuration center form controls to shadcn primitives ([cfe65c5](https://github.com/jeffusion/bungee/commit/cfe65c5c3014246e2eeb6ea8f13ff2bb32df2f35))
* **ui:** wire BDropdownAction trigger via bits-ui Trigger ([31f7dd4](https://github.com/jeffusion/bungee/commit/31f7dd4d3ef9b9a80fa8cbbe264ed8d4f33c174b))


### Features

* **core:** implement four-layer plugin lifecycle with phase-aware execution ([379c23b](https://github.com/jeffusion/bungee/commit/379c23b3293d594c96b38bfca5480df29db87bad))
* **plugin:** add deepseek-reasoning-fix plugin ([0f3ae3c](https://github.com/jeffusion/bungee/commit/0f3ae3c5d491db313bb7bec2600367c5d8d125bc))
* **ui:** add NxSelect component, replace all native <select> in Logs page ([e760463](https://github.com/jeffusion/bungee/commit/e7604632afc1ceb0027fb246f1637faf45191b7e))
* **ui:** add route overview panel to dashboard and unify section titles ([b5a2bfc](https://github.com/jeffusion/bungee/commit/b5a2bfca297232d5c14310f095274e6d54fad196))
* **ui:** change dashboard KPI from requests/sec to requests/min ([10e8b11](https://github.com/jeffusion/bungee/commit/10e8b11d3c4fe16de546bfb51f92331c981dd75b))
* **ui:** complete shadcn-svelte migration and route editor overhaul ([e863696](https://github.com/jeffusion/bungee/commit/e8636967d3fd0f4708111f612ef2e9cc61126843))
* **ui:** drop Plugin Scope Model static panel from plugins page ([44d496d](https://github.com/jeffusion/bungee/commit/44d496d8dcaf0ff547544f443d2219f6bcbbb98e))
* **ui:** migrate dashboard to shadcn primitives ([bf37dd7](https://github.com/jeffusion/bungee/commit/bf37dd72d7a8f76cfe9d7dff980bd408fad23ad0))
* **ui:** migrate service management and failover/sticky/upstream forms to industrial primitives ([75be638](https://github.com/jeffusion/bungee/commit/75be638785caa66c63ede75a34162cac1139f613))
* **ui:** redesign MetricBar with industrial allocation bar style ([8df3355](https://github.com/jeffusion/bungee/commit/8df3355eef1f8b845ff5d5307b26609c6910cbd5))
* **ui:** unify industrial primitives and multi-size switch with glyph slot ([91dadb2](https://github.com/jeffusion/bungee/commit/91dadb238ace6980750e76c5db5c4ad19800c589))
* **ui:** upgrade dashboard KPI card from service-only to cluster overview ([4540a75](https://github.com/jeffusion/bungee/commit/4540a7518bc1099388a5cfce3e0cd0408c995470)), closes [#5](https://github.com/jeffusion/bungee/issues/5)

# [4.1.0](https://github.com/jeffusion/bungee/compare/v4.0.0...v4.1.0) (2026-05-26)


### Features

* **core/api:** expose Service endpoints in REST API and support new config model ([cf77d18](https://github.com/jeffusion/bungee/commit/cf77d1876fef23afa0571c6228544c843cfc0922))
* **core:** implement inline endpoints to service migration and v2-v3 migrations ([64dc901](https://github.com/jeffusion/bungee/commit/64dc901c05eec094eb32f7f317d16f852cf19d0c))
* **ui/i18n:** add Service, Endpoint, and design system translation keys ([52c0944](https://github.com/jeffusion/bungee/commit/52c0944f9636998fc160ca118b9aa44b0aca2972))
* **ui:** add industrial design system primitive component library ([cc00f9a](https://github.com/jeffusion/bungee/commit/cc00f9a91c0b7f67d04a762dd371796aa3e4e34f))
* **ui:** add industrial loading indicator ([2f30130](https://github.com/jeffusion/bungee/commit/2f30130b57424c9d0d07ece8bf964e09f0a8a314))
* **ui:** add new route/service editor components and sections ([e60629b](https://github.com/jeffusion/bungee/commit/e60629b63e30619c8372a8499d6ae211eb9c8273))
* **ui:** add service API helpers and route-service view model utilities ([0076023](https://github.com/jeffusion/bungee/commit/0076023ce71a2018b3a1de85b9cd590ec515ea8d))
* **ui:** add Service management pages and update Dashboard and Configuration ([1507b2b](https://github.com/jeffusion/bungee/commit/1507b2beca2d6c498cf3ac2dee2bfd5d076d64b2))
* **ui:** enhance configuration status and operations layout ([767d9e7](https://github.com/jeffusion/bungee/commit/767d9e71d1a89bfb2e6fe7943f37d0253dc99f10))
* **ui:** introduce industrial design system, theme tokens, and base styles ([c93b274](https://github.com/jeffusion/bungee/commit/c93b2748be8fbda8a698791895cd2979dfb03c0b))
* **ui:** refactor RoutesIndex and RouteEditor for Service model support ([bc2f999](https://github.com/jeffusion/bungee/commit/bc2f999a27597ffca62e9bf852c5c3a260c5181a))
* **ui:** update App.svelte root layout for v3 navigation and theme ([0ec3781](https://github.com/jeffusion/bungee/commit/0ec37814eb872068a1bbc7df64b25ef97f081500))
* **ui:** update DesignSystem page with industrial theme primitives ([62a14dd](https://github.com/jeffusion/bungee/commit/62a14dd9fe0e16ed4a8bd8279588d375d70fadd9))
* **ui:** update Login, Logs, Plugins, and NotFound pages for v3 theme ([f173eae](https://github.com/jeffusion/bungee/commit/f173eaebd9ec85bd5551068d8ed1c1613fb926b4))
* **ui:** update types and validators for V3 Service and snake_case model ([9d10ca9](https://github.com/jeffusion/bungee/commit/9d10ca92f3d0effa695d04ba473b8d029585d0f3))

# [4.0.0](https://github.com/jeffusion/bungee/compare/v3.3.1...v4.0.0) (2026-05-05)


### Bug Fixes

* **failover:** ensure probeTimeoutMs respects failover.enabled ([0e9256c](https://github.com/jeffusion/bungee/commit/0e9256cfb176cc262fa56747c20751de8cbf649c))


### Features

* **ui:** redesign logo and add favicon support ([d675797](https://github.com/jeffusion/bungee/commit/d675797e116d6ca20048996b2f1671d9eea30f74)), closes [#4F46E5](https://github.com/jeffusion/bungee/issues/4F46E5) [#0D9488](https://github.com/jeffusion/bungee/issues/0D9488)


### BREAKING CHANGES

* **failover:** Configuration structure changed from:
  - failover.requestTimeoutMs → timeouts.requestMs
  - failover.connectTimeoutMs → timeouts.connectMs
  - failover.recoveryTimeoutMs → failover.recovery.probeTimeoutMs

Migration is handled automatically via config-migrations framework.

Closes: <issue-number>

## [3.3.1](https://github.com/jeffusion/bungee/compare/v3.3.0...v3.3.1) (2026-05-04)


### Bug Fixes

* **gemini:** repair thought signature handling ([8b364c4](https://github.com/jeffusion/bungee/commit/8b364c4bd378f920aea1274a5578fd89bf277aac))
* **llms:** align anthropic openai parity ([43f79a6](https://github.com/jeffusion/bungee/commit/43f79a6cbdb7a7a0811372818f1d15c791959363))

# [3.3.0](https://github.com/jeffusion/bungee/compare/v3.2.1...v3.3.0) (2026-04-13)


### Bug Fixes

* **ai-transformer:** stop injecting stream_options during anthropic conversion ([8c0df80](https://github.com/jeffusion/bungee/commit/8c0df80b6660cacd5d2cab1b3df44358730d2c87))
* **build:** rewrite built plugin manifest entrypoints ([73796c6](https://github.com/jeffusion/bungee/commit/73796c629cd7054629e797c2c5bf2a811272bee9))
* **ci:** add build:llms step before running tests ([8feb1b7](https://github.com/jeffusion/bungee/commit/8feb1b77b99e2422ffa4a21b9d6fc8fa79ab79f7))
* **ci:** add build:llms step to release workflow ([57c85d7](https://github.com/jeffusion/bungee/commit/57c85d7a971f61abddafd4de635adb0caa459882))
* **core:** limit dev plugin discovery to project plugins ([aa44903](https://github.com/jeffusion/bungee/commit/aa449032e7a56b0c6d386827f5f7a888516ca9ab))
* **core:** load named plugins from cached manifests ([58ac632](https://github.com/jeffusion/bungee/commit/58ac6320b26ad6be7752a76c203efee8f3cc57a0))
* **core:** share editor model catalogs across workers ([b8a4347](https://github.com/jeffusion/bungee/commit/b8a43477846e1dde7e5ba2e646f523475a392c5e))
* **i18n:** add missing common.select translation key ([12d3970](https://github.com/jeffusion/bungee/commit/12d3970ff04af3495b802bb37e9defd64671f431))
* **test:** isolate plugin-editor-models from CI auth config ([01e3e9f](https://github.com/jeffusion/bungee/commit/01e3e9fe34fefffd73e957b70ae05944c3e60383))
* **token-stats:** keep streaming token tracking side-effect free ([34e18fb](https://github.com/jeffusion/bungee/commit/34e18fbc39207d5b6e03ecbca523bac43a4b2b1a))
* **ui:** localize dynamic plugin form copy ([f80b067](https://github.com/jeffusion/bungee/commit/f80b067242f27d2816e636f0954fbfa61e890f61))
* **ui:** restore plugin metadata translations ([447f94b](https://github.com/jeffusion/bungee/commit/447f94bb22a7b0500837dae2d20ab55ceb2da799))
* **ui:** translate plugin detail and editor metadata ([50e021a](https://github.com/jeffusion/bungee/commit/50e021a007f25a6ceeff0b6e6114bd31dcadfde9))


### Features

* **core:** add multi-worker plugin convergence ([9a0dc36](https://github.com/jeffusion/bungee/commit/9a0dc362ffc21253653292cbd3239d07dff0f8fa))
* **core:** add plugin artifact contract validation ([e10ce2d](https://github.com/jeffusion/bungee/commit/e10ce2d98b8ed89f7b708bd950c6ec25de067fcc))
* **core:** add plugin runtime orchestrator ([71ea3de](https://github.com/jeffusion/bungee/commit/71ea3de7417d44d202febf4c490293da58089cec))
* **core:** add plugin runtime state machine ([47e3295](https://github.com/jeffusion/bungee/commit/47e3295c7266160ded9edec16ccd7df022093ed1))
* **core:** enforce scoped plugin rollback semantics ([0591b4e](https://github.com/jeffusion/bungee/commit/0591b4ef9764dcd7324ba462e5abb9aa6df55cf5))
* **core:** finalize plugin hooks after stream completion ([a1566f6](https://github.com/jeffusion/bungee/commit/a1566f6e5c1dba000347f91c3c62bf35643f7edf))
* **core:** gate sandbox plugin assets by runtime state ([1f6078a](https://github.com/jeffusion/bungee/commit/1f6078a36a283229cccb16567a6518805b2c3719))
* **core:** reconcile plugin API control plane ([e52295d](https://github.com/jeffusion/bungee/commit/e52295d7b2bde04406aafc1f90cfc9aaa7141005))
* **llms:** add canonical token accounting primitives ([38310bd](https://github.com/jeffusion/bungee/commit/38310bd394e5f39ee92a0936c3a06636bf0f65b3))
* **model-mapping:** manual catalog management with searchable UI ([6dc2ffb](https://github.com/jeffusion/bungee/commit/6dc2ffbc504935ebe95dddd92cd51720a877ed06))
* **plugins:** migrate built-in plugin manifests to vnext ([6959fbf](https://github.com/jeffusion/bungee/commit/6959fbfdabaee30c5450d005a5f51dbd6a54b4e4))
* **token-stats:** add v2 aggregate stats pipeline ([ef799c8](https://github.com/jeffusion/bungee/commit/ef799c8cb0b825386f10506572a4f34ab43e6a42))

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
