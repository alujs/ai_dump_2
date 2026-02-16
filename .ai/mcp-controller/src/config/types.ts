export interface GatewayConfig {
  dashboardPort: number;
  repo: {
    root: string;
    worktreeRoot: string;
  };
  neo4j: {
    uri: string;
    username: string;
    password: string;
    database: string;
  };
  graph: {
    seedRoot: string;
    outRoot: string;
    cypherRoot: string;
  };
  jira: {
    baseUrl: string;
    projectKey?: string;
    patFilePath: string;
  };
  swagger: {
    roots: string[];
  };
  recipes: {
    manifestPath: string;
  };
  hints: {
    angularRoots: string[];
    federationMappings: string[];
  };
  parserTargets: {
    typescript: string[];
    templates: string[];
    json: string[];
    yaml: string[];
  };
  features: {
    browserAutomationEnabled: boolean;
  };
  ingestion: {
    includes: string[];
    excludes: string[];
  };
}

export const DEFAULT_CONFIG: GatewayConfig = {
  dashboardPort: 8722,
  repo: {
    root: ".",
    worktreeRoot: ".ai/tmp/work"
  },
  neo4j: {
    uri: "bolt://127.0.0.1:7687",
    username: "neo4j",
    password: "12345678",
    database: "piopex"
  },
  graph: {
    seedRoot: ".ai/graph/seed",
    outRoot: ".ai/graph/out",
    cypherRoot: ".ai/graph/cypher"
  },
  jira: {
    baseUrl: "",
    patFilePath: ".ai/auth/jira.token"
  },
  swagger: {
    roots: []
  },
  recipes: {
    manifestPath: ".ai/graph/seed/recipe/manifest.jsonl"
  },
  hints: {
    angularRoots: ["src", "apps", "libs", "projects", "packages"],
    federationMappings: []
  },
  parserTargets: {
    typescript: ["src", "apps", "libs", "projects", "packages"],
    templates: ["src", "apps", "libs", "projects", "packages"],
    json: ["src", "apps", "libs", "projects", "packages"],
    yaml: ["src", "apps", "libs", "projects", "packages"]
  },
  features: {
    browserAutomationEnabled: false
  },
  ingestion: {
    includes: [
      "src/**/*.{ts,tsx,js,mjs,cjs,html,json,yaml,yml}",
      "apps/**/*.{ts,tsx,js,mjs,cjs,html,json,yaml,yml}",
      "libs/**/*.{ts,tsx,js,mjs,cjs,html,json,yaml,yml}",
      "projects/**/*.{ts,tsx,js,mjs,cjs,html,json,yaml,yml}",
      "packages/**/*.{ts,tsx,js,mjs,cjs,html,json,yaml,yml}"
    ],
    excludes: ["**/dist/**", "**/node_modules/**", "**/.angular/**"]
  }
};
