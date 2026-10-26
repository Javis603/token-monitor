'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pluginTypes,normalizeTypes}=require('../../src/electron/plugins/types');
test('types derive from actual surfaces/targets and optional skins',()=>{
 assert.deepEqual(pluginTypes({views:[{surfaces:['home','notch','page']}],skins:[{}]}),['widget','page','appearance']);
 assert.deepEqual(pluginTypes({views:[{targets:['main.limits.content']}]}),['page']);
 assert.deepEqual(pluginTypes({views:[{surfaces:['settings']}]}),[]);
 assert.deepEqual(normalizeTypes(['page','bogus','page']),['page']);
});
