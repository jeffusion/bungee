<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Route } from '../api/routes';

  export let showTemplates = false;

  const dispatch = createEventDispatcher();

  const templates: Array<{ name: string; description: string; template: Partial<Route> }> = [
    {
      name: 'Simple Proxy',
      description: 'Basic reverse proxy to a single upstream',
      template: {
        path: '/api',
        upstreams: [
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
        upstreams: [
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
        upstreams: [
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
          retryableStatusCodes: [500, 502, 503, 504]
        }
      }
    },
    {
      name: 'Anthropic to Gemini',
      description: 'Convert Anthropic API to Google Gemini format',
      template: {
        path: '/v1/messages',
        transformer: 'anthropic-to-gemini',
        upstreams: [
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
        upstreams: [
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
        upstreams: [
          {
            target: 'https://api.example.com',
            weight: 100,
            priority: 1
          }
        ],
        healthCheck: {
          enabled: true,
          interval: 30000,
          timeout: 5000,
          path: '/health'
        }
      }
    },
    {
      name: 'Path Rewrite',
      description: 'Route with path rewriting',
      template: {
        path: '/api/v2',
        upstreams: [
          {
            target: 'https://api.example.com',
            weight: 100,
            priority: 1
          }
        ],
        pathRewrite: {
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
  <div class="modal modal-open">
    <div class="modal-box max-w-4xl">
      <h3 class="font-bold text-lg mb-4">Select Route Template</h3>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        {#each templates as template}
          <button
            type="button"
            class="card card-compact bg-base-200 hover:bg-base-300 cursor-pointer text-left"
            on:click={() => selectTemplate(template)}
          >
            <div class="card-body">
              <h4 class="card-title text-base">{template.name}</h4>
              <p class="text-sm text-gray-600">{template.description}</p>
              <div class="mt-2">
                <div class="text-xs font-mono bg-base-100 p-2 rounded max-h-32 overflow-auto">
                  {JSON.stringify(template.template, null, 2)}
                </div>
              </div>
            </div>
          </button>
        {/each}
      </div>

      <div class="modal-action">
        <button
          type="button"
          class="btn btn-sm"
          on:click={() => showTemplates = false}
        >
          Close
        </button>
      </div>
    </div>
    <button
      type="button"
      class="modal-backdrop"
      on:click={() => showTemplates = false}
      aria-label="Close modal"
    ></button>
  </div>
{/if}
