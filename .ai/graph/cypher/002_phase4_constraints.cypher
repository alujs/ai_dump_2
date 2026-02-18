CREATE CONSTRAINT symbol_id_unique IF NOT EXISTS
FOR (n:SymbolDefinition) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT component_id_unique IF NOT EXISTS
FOR (n:Component) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT prop_id_unique IF NOT EXISTS
FOR (n:Prop) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT usage_example_id_unique IF NOT EXISTS
FOR (n:UsageExample) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT migration_rule_id_unique IF NOT EXISTS
FOR (n:MigrationRule) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT domain_anchor_id_unique IF NOT EXISTS
FOR (n:DomainAnchor) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT ui_intent_id_unique IF NOT EXISTS
FOR (n:UIIntent) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT component_intent_id_unique IF NOT EXISTS
FOR (n:ComponentIntent) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT macro_constraint_id_unique IF NOT EXISTS
FOR (n:MacroConstraint) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT file_id_unique IF NOT EXISTS
FOR (n:File) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT angular_route_id_unique IF NOT EXISTS
FOR (n:AngularRoute) REQUIRE n.id IS UNIQUE;
