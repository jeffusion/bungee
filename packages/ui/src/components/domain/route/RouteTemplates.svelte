<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Route } from '$api/routes';

  export let showTemplates = false;

  const dispatch = createEventDispatcher();

  const templates: Array<{ name: string; description: string; template: Partial<Route> }> = [
    {
      name: 'Simple Proxy',
      description: 'Basic reverse proxy to a single upstream',
      template: {
        path: '/api',
        endpoints: [
          {
            target: 'https://api.example.com',
            weight: 100,
            priority: 1
          }
        ]
      }
    },
    {
      name: 'Load Balanced',
      description: 'Multiple upstreams with load balancing',
      template: {
        path: '/api',
        endpoints: [
          {
            target: 'https://api1.example.com',
            weight: 100,
            priority: 1
          },
          {
            target: 'https://api2.example.com',
            weight: 100,
            priority: 1
          }
        ]
      }
    },
    {
      name: 'Failover Setup',
      description: 'Primary and backup upstreams with failover',
      template: {
        path: '/api',
        endpoints: [
          {
            target: 'https://primary.example.com',
            weight: 200,
            priority: 1
          },
          {
            target: 'https://backup.example.com',
            weight: 100,
            priority: 2
          }
        ],
        failover: {
          enabled: true,
          retry_on: [500, 502, 503, 504]
        }
      }
    },
    {
      name: 'Anthropic to Gemini',
      description: 'Convert Anthropic API to Google Gemini format',
      template: {
        path: '/v1/messages',
        transformer: 'anthropic-to-gemini',
        endpoints: [
          {
            target: 'https://generativelanguage.googleapis.com',
            weight: 100,
            priority: 1
          }
        ]
      }
    },
    {
      name: 'Anthropic to OpenAI',
      description: 'Convert Anthropic API to OpenAI format',
      template: {
        path: '/v1/messages',
        transformer: 'anthropic-to-openai',
        endpoints: [
          {
            target: 'https://api.openai.com',
            weight: 100,
            priority: 1
          }
        ]
      }
    },
    {
      name: 'Health Checked API',
      description: 'API with health checks enabled',
      template: {
        path: '/api',
        endpoints: [
          {
            target: 'https://api.example.com',
            weight: 100,
            priority: 1
          }
        ],
        failover: {
          enabled: true,
          health_check: {
            enabled: true,
            interval_ms: 30000,
            timeout_ms: 5000,
            path: '/health'
          }
        }
      }
    },
    {
      name: 'Path Rewrite',
      description: 'Route with path rewriting',
      template: {
        path: '/api/v2',
        endpoints: [
          {
            target: 'https://api.example.com',
            weight: 100,
            priority: 1
          }
        ],
        path_rewrite: {
          '^/api/v2': '/v1'
        }
      }
    }
  ];

  function selectTemplate(template: typeof templates[0]) {
    dispatch('select', template.template);
    showTemplates = false;
  }
</script>

{#if showTemplates}
  <div class="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm">
    <div class="nx-panel-raised nx-bracketed w-full max-w-4xl p-5">
      <h3 class="font-bold text-lg mb-4">Select Route Template</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {#each templates as template}
          <button
            type="button"
            class="border border-carbon-600 bg-carbon-900 p-4 text-left transition-colors hover:border-nexus-500/50 hover:bg-carbon-700/60"
            on:click={() => selectTemplate(template)}
          >
            <div class="space-y-2">
              <h4 class="text-base font-semibold text-zinc-100">{template.name}</h4>
              <p class="text-sm text-gray-600">{template.description}</p>
              <div class="mt-2">
                <div class="text-xs font-mono bg-carbon-950 p-2 rounded max-h-32 overflow-auto">
                  {JSON.stringify(template.template, null, 2)}
                </div>
              </div>
            </div>
          </button>
        {/each}
      </div>

      <div class="mt-5 flex justify-end">
        <button
          type="button"
          class="nx-btn-ghost nx-btn-sm"
          on:click={() => showTemplates = false}
        >
          Close
        </button>
      </div>
    </div>
    <button
      type="button"
      class="absolute inset-0 -z-10"
      on:click={() => showTemplates = false}
      aria-label="Close modal"
    ></button>
  </div>
{/if}
