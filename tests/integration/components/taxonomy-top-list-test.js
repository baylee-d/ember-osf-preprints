import EmberObject from '@ember/object';

import { moduleForComponent, test } from 'ember-qunit';
import hbs from 'htmlbars-inline-precompile';

moduleForComponent('taxonomy-top-list', 'Integration | Component | taxonomy top list', {
    integration: true,
});

test('it renders', function(assert) {
    this.set('list', [
        EmberObject.create({ text: 'b' }),
        EmberObject.create({ text: 'a' }),
    ]);
    this.render(hbs`{{taxonomy-top-list list=list}}`);

    // Should be sorted as 'ab', not 'ba'
    assert.equal(this.$().text().replace(/\s/g, ''), 'ab');

    assert.ok(this.$('.subject-item').length);
    assert.ok(this.$('.subject-item a').length);
});
