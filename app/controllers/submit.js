import { A } from '@ember/array';
import { computed } from '@ember/object';
import { get } from '@ember/object';
import { inject } from '@ember/service';
import { merge } from '@ember/polyfills';
import { observer } from '@ember/object';
import { run } from '@ember/runloop';
import Controller from '@ember/controller';
import EmberObject from '@ember/object';

import config from 'ember-get-config';
import { validator, buildValidations } from 'ember-cp-validations';
import $ from 'jquery';

import Analytics from 'ember-osf/mixins/analytics';
import permissions from 'ember-osf/const/permissions';
import NodeActionsMixin from 'ember-osf/mixins/node-actions';
import TaggableMixin from 'ember-osf/mixins/taggable-mixin';
import loadAll from 'ember-osf/utils/load-relationship';
import fixSpecialChar from 'ember-osf/utils/fix-special-char';
import extractDoiFromString from 'ember-osf/utils/extract-doi-from-string';

// Enum of available upload states > New project or existing project?
export const State = Object.freeze(EmberObject.create({
    START: 'start',
    NEW: 'new',
    EXISTING: 'existing'
}));

// Enum of available file states > New file or existing file?
export const existingState = Object.freeze(EmberObject.create({
    CHOOSE: 'choose',
    EXISTINGFILE: 'existing',
    NEWFILE: 'new'
}));

// Form data and validations
const BasicsValidations = buildValidations({
    basicsAbstract: {
        description: 'Abstract',
        validators: [
            validator('presence', true),
            validator('length', {
                // currently min of 20 characters -- this is what arXiv has as the minimum length of an abstract
                min: 20,
                max: 5000
            })
        ]
    },
    basicsDOI: {
        description: 'DOI',
        validators: [
            validator('format', {
                // Simplest regex- try not to diverge too much from the backend
                regex: /\b(10\.\d{4,}(?:\.\d+)*\/\S+(?:(?!["&'<>])\S))\b/,
                allowBlank: true,
                message: 'Please use a valid {description}'
            })
        ]
    },
    basicsOriginalPublicationDate: {
        description: 'Original publication date',
        validators: [
            validator('date', {
                onOrBefore: 'now',
                precision: 'day',
            })
        ]
    }

});

const PENDING = 'pending';
const ACCEPTED = 'accepted';
const REJECTED = 'rejected';

const PRE_MODERATION = 'pre-moderation';
const POST_MODERATION = 'post-moderation';

const MODAL_TITLE = {
    create: 'components.confirm-share-preprint.title.create',
    submit: 'components.confirm-share-preprint.title.submit',
    resubmit: 'components.confirm-share-preprint.title.resubmit'
};

const SUBMIT_MESSAGES = {
    default: 'submit.body.submit.information.line1.default',
    moderation: 'submit.body.submit.information.line1.moderation',
    [PRE_MODERATION]: 'submit.body.submit.information.line3.pre',
    [POST_MODERATION]: 'submit.body.submit.information.line3.post',
};

const PERMISSION_MESSAGES = {
    create: 'submit.body.submit.information.line2.create',
    submit: 'submit.body.submit.information.line2.submit'
};

const EDIT_MESSAGES = {
    line1: {
        [PRE_MODERATION]: 'submit.body.edit.information.line1.pre',
        [POST_MODERATION]: 'submit.body.edit.information.line1.post_rejected'
    },
    line2: {
        [PENDING]: {
            [PRE_MODERATION]: 'submit.body.edit.information.line2.pre_pending',
        },
        [REJECTED]: {
            [PRE_MODERATION]: 'submit.body.edit.information.line2.pre_rejected',
            [POST_MODERATION]: 'submit.body.edit.information.line2.post_rejected'
        }
    }
};

const WORKFLOW = {
    [PRE_MODERATION]: 'global.pre_moderation',
    [POST_MODERATION]: 'global.post_moderation'
};

const ACTION = {
    create: {
        heading: 'submit.create_heading',
        button: 'submit.body.submit.create_button'
    },
    submit: {
        heading: 'submit.submit_heading',
        button: 'submit.body.submit.submit_button'
    }
};

function subjectIdMap(subjectArray) {
    // Maps array of arrays of disciplines into array of arrays of discipline ids.
    return subjectArray.map(subjectBlock => subjectBlock.map(subject => subject.id));
}

/**
 * @module ember-preprints
 * @submodule controllers
 */

/**
 * @class Submit Controller
 */
export default Controller.extend(Analytics, BasicsValidations, NodeActionsMixin, TaggableMixin, {
    i18n: inject(),
    theme: inject(),
    fileManager: inject(),
    toast: inject('toast'),
    panelActions: inject('panelActions'),

    _State: State, // Project states - new project or existing project
    filePickerState: State.START, // Selected upload state (initial decision on form) - new or existing project? (is poorly named)
    _existingState: existingState, // File states - new file or existing file
    existingState: existingState.CHOOSE, // Selected file state - new or existing file (poorly named)
    _names: ['server', 'upload', 'discipline', 'basics', 'authors'].map(str => str.capitalize()), // Form section headers

    // Data for project picker; tracked internally on load
    user: null,
    userNodes: A(),
    userNodesLoaded: false,

    availableLicenses: A(),
    applyLicense: false,
    newNode: false,

    // Information about the thing to be turned into a preprint
    node: null, // Project or component containing the preprint
    file: null, // Preuploaded file - file that has been dragged to dropzone, but not uploaded to node.
    selectedFile: null, // File that will be the preprint (already uploaded to node or selected from existing node)
    contributors: A(), // Contributors on preprint - if creating a component, contributors will be copied over from parent
    title: null, // Preprint title
    nodeLocked: false, // IMPORTANT PROPERTY. After advancing beyond Step 1: Upload on Add Preprint form, the node is locked.  Is True on Edit.
    searchResults: [], // List of users matching search query
    savingPreprint: false, // True when Share button is pressed on Add Preprint page
    showModalSharePreprint: false, // True when sharing preprint confirmation modal is displayed
    serverSaveState: false, // True temporarily when changes have been saved in server section
    uploadSaveState: false, // True temporarily when changes have been saved in upload section
    disciplineSaveState: false, // True temporarily when changes have been saved in discipline section
    basicsSaveState: false, // True temporarily when changes have been saved in basics section
    authorsSaveState: false, // True temporarily when changes have been saved in authors section
    parentNode: null, // If component created, parentNode will be defined
    parentContributors: A(), // Contributors on parent project
    convertProjectConfirmed: false, // User has confirmed they want to convert their existing OSF project into a preprint,
    convertOrCopy: null, // Will either be 'convert' or 'copy' depending on whether user wants to use existing component or create a new component.
    osfStorageProvider: null, // Preprint node's osfStorage object
    osfProviderLoaded: false, // Preprint node's osfStorageProvider is loaded.
    titleValid: null,  // If node's pending title is valid.
    uploadInProgress: false, // Set to true when upload step is underway,
    existingPreprints: A(), // Existing preprints on the current node
    abandonedPreprint: null, // Abandoned(draft) preprint on the current node
    editMode: false, // Edit mode is false by default.
    shareButtonDisabled: false, // Relevant in Add mode - flag prevents users from sending multiple requests to server

    attemptedSubmit: false, // True when user has tried to submit with validation errors

    isTopLevelNode: computed.not('node.parent.id'),

    hasFile: computed.or('file', 'selectedFile'),

    allProviders: [], // Initialize with an empty list of providers
    currentProvider: undefined,
    selectedProvider: undefined,
    providerSaved: false,
    preprintSaved: false,

    init() {
        let controller = this;
        this.get('store')
            .findAll('preprint-provider', { reload: true })
            .then((providers) => {
                controller.set(
                    'allProviders',
                    // OSF first, then all the rest
                    providers.filter(item => item.id === 'osf').concat(providers.filter(item => item.id !== 'osf'))
                );
                const currentProvider = providers.filter(item => item.id === controller.get('theme.id') || config.PREPRINTS.provider)[0];
                controller.set('currentProvider', currentProvider);
                controller.set('selectedProvider', currentProvider);
                this.get('theme.isProvider') && this.set('providerSaved', true);
            });
    },

    // True if fields have been changed
    hasDirtyFields: computed('theme.isProvider', 'hasFile', 'preprintSaved', 'isAddingPreprint', 'providerSaved', 'uploadChanged', 'basicsChanged', 'disciplineChanged', function() {
        const preprintStarted = this.get('theme.isProvider') ? this.get('hasFile') : this.get('providerSaved');
        return !this.get('preprintSaved') && (this.get('isAddingPreprint') && preprintStarted || this.get('uploadChanged') || this.get('basicsChanged') || this.get('disciplineChanged'));
    }),

    isAddingPreprint: computed.not('editMode'),

    clearFields() {
        // Restores submit form defaults.  Called when user submits preprint, then hits back button, for example.
        this.get('panelActions').open('Upload');

        this.setProperties(merge(
            this.get('_names').reduce((acc, name) => merge(acc, {[`${name.toLowerCase()}SaveState`]: false}), {}), {
            filePickerState: State.START,
            existingState: existingState.CHOOSE,
            user: null,
            userNodes: A(),
            userNodesLoaded: false,
            node: null,
            file: null,
            selectedFile: null,
            contributors: A(),
            title: null,
            nodeLocked: false, // Will be set to true if edit?
            searchResults: [],
            savingPreprint: false,
            showModalSharePreprint: false,
            serverSaveState: false,
            uploadSaveState: false,
            disciplineSaveState: false,
            basicsSaveState: false,
            authorsSaveState: false,
            parentNode: null,
            parentContributors: A(),
            convertProjectConfirmed: false,
            convertOrCopy: null,
            osfStorageProvider: null,
            titleValid: null,
            uploadInProgress: false,
            existingPreprints: A(),
            abandonedPreprint: null,
            editMode: false,
            shareButtonDisabled: false,
            // Basics and subjects fields need to be reset because the Add process overwrites the computed properties as reg properties
            basicsTags: A(),
            basicsAbstract: null,
            basicsDOI: null,
            basicsOriginalPublicationDate: null,
            basicsLicense: null,
            subjectsList: A(),
            availableLicenses: A(),
            applyLicense: false,
            newNode: false,
            attemptedSubmit: false,
        }));
    },

    ///////////////////////////////////////
    // Validation rules and changed states for form sections

    providerChanged: true,

    // In order to advance from upload state, node and selectedFile must have been defined, and title must be set.
    uploadValid: computed.alias('nodeLocked'), // Once the node has been locked (happens in step one of upload section), users are free to navigate through form unrestricted
    abstractValid: computed.alias('validations.attrs.basicsAbstract.isValid'),
    doiValid: computed.alias('validations.attrs.basicsDOI.isValid'),
    originalPublicationDateValid: computed.alias('validations.attrs.basicsOriginalPublicationDate.isValid'),

    // Must have year and copyrightHolders filled if those are required by the licenseType selected
    licenseValid: false,

    // Basics fields that are being validated are abstract, license and doi (title validated in upload section). If validation added for other fields, expand basicsValid definition.
    basicsValid: computed.and('abstractValid', 'doiValid', 'licenseValid', 'originalPublicationDateValid'),

    // Must have at least one contributor. Backend enforces admin and bibliographic rules. If this form section is ever invalid, something has gone horribly wrong.
    authorsValid: computed.bool('contributors.length'),

    // Must select at least one subject (looking at pending subjects)
    disciplineValid: computed.notEmpty('subjectsList'),

    // Does node have a saved title?
    savedTitle: computed.notEmpty('model.title'),

    // Does preprint have a saved primaryFile?
    savedFile: computed.notEmpty('model.primaryFile.content'),

    // Does node have a saved description?
    savedAbstract: computed.notEmpty('model.description'),

    // Does preprint have saved subjects?
    savedSubjects: computed.notEmpty('model.subjects'),

    // Preprint can be published once all required sections have been saved.
    allSectionsValid: computed.and('savedTitle', 'savedFile', 'savedAbstract', 'savedSubjects', 'authorsValid'),

    // Are there validation errors which should be displayed right now?
    showValidationErrors: computed('attemptedSubmit', 'allSectionsValid', function() {
        return this.get('attemptedSubmit') && !this.get('allSectionsValid');
    }),

    ////////////////////////////////////////////////////
    // Fields used in the "upload" section of the form.
    ////////////////////////////////////////////////////

    // Does the pending primaryFile differ from the primary file already saved?
    preprintFileChanged: computed('model.primaryFile', 'selectedFile', 'file', function() {
        return this.get('selectedFile.id') && (this.get('model.primaryFile.id') !== this.get('selectedFile.id')) || this.get('file') !== null;
    }),

    // Does the pending title differ from the title already saved?
    titleChanged: computed('model.title', 'title', function() {
        return this.get('model.title') != this.get('title');
    }),

    // Are there any unsaved changes in the upload section?
    uploadChanged: computed.or('preprintFileChanged', 'titleChanged'),

    ////////////////////////////////////////////////////
    // Fields used in the "basics" section of the form.
    ////////////////////////////////////////////////////

    // Pending abstract

    basicsAbstract:  computed('model.description', function() {
        return this.get('model.description') || null;
    }),

    // Does the pending abstract differ from the saved abstract in the db?
    abstractChanged: computed('basicsAbstract', 'model.description', function() {
        let basicsAbstract = this.get('basicsAbstract');
        return basicsAbstract !== null && basicsAbstract.trim() !== this.get('model.description');
    }),

    // Pending tags
    basicsTags: computed('model.tags', function() {
        let tags = this.get('model.tags');
        return (tags && tags.map(fixSpecialChar)) || A();
    }),

    // Does the list of pending tags differ from the saved tags in the db?
    tagsChanged: computed('basicsTags.@each', 'model.tags', function() {
        const basicsTags = this.get('basicsTags');
        const tags = this.get('model.tags');

        return basicsTags && tags &&
            (
                basicsTags.length !== tags.length ||
                basicsTags.some(
                    (v, i) => fixSpecialChar(v) !== fixSpecialChar(tags[i])
                )
            );
    }),

    basicsDOI: computed.or('model.doi'),

    doiChanged: computed('model.doi', 'basicsDOI', function() {
        // Does the pending DOI differ from the saved DOI in the db?
        // If pending DOI and saved DOI are both falsy values, doi has not changed.
        const basicsDOI = extractDoiFromString(this.get('basicsDOI'));
        const modelDOI = this.get('model.doi');
        return (basicsDOI || modelDOI) && basicsDOI !== modelDOI;
    }),

    // This loads up the current license information if the preprint has one, otherwise initializes the
    // license object with null values
    basicsLicense: computed('model', function() {
        let record = this.get('model.licenseRecord');
        let license = this.get('model.license');
        return {
            year: record ? record.year : null,
            copyrightHolders: record && record.copyright_holders ? record.copyright_holders.join(', ') : '',
            licenseType: license || null
        };
    }),

    licenseChanged: computed('model.license', 'model.licenseRecord', 'basicsLicense.year', 'basicsLicense.copyrightHolders', 'basicsLicense.licenseType', function() {
        let changed = false;
        if (this.get('model.licenseRecord') || this.get('model.license.content')) {
            changed |= (this.get('model.license.name') !== this.get('basicsLicense.licenseType.name'));
            changed |= (this.get('model.licenseRecord').year !== this.get('basicsLicense.year'));
            changed |= ((this.get('model.licenseRecord.copyright_holders.length') ? this.get('model.licenseRecord.copyright_holders').join(', ') : '') !== this.get('basicsLicense.copyrightHolders'));
        } else {
            changed |= ((this.get('availableLicenses').toArray().length ? this.get('availableLicenses').toArray()[0].get('name') : null) !== this.get('basicsLicense.licenseType.name'));
            changed |= ((new Date()).getUTCFullYear().toString() !== this.get('basicsLicense.year'));
            changed |= !(this.get('basicsLicense.copyrightHolders') === '' || !this.get('basicsLicense.copyrightHolders.length') || this.get('basicsLicense.copyrightHolders') === null);
        }

        return changed;
    }),

    //This is done to initialize basicsOriginalPublicationDate to the date fetched from an existing preprint, similar to how basicsDOI is initialized.
    basicsOriginalPublicationDate: computed.or('model.originalPublicationDate'),

    originalPublicationDateChanged: computed('model.originalPublicationDate', 'basicsOriginalPublicationDate', function () {
        let basicsOriginalPublicationDate = this.get('basicsOriginalPublicationDate');
        let modelOriginalPublicationDate = this.get('model.originalPublicationDate');
        return (basicsOriginalPublicationDate || modelOriginalPublicationDate) && basicsOriginalPublicationDate !== modelOriginalPublicationDate;
    }),

    // Are there any unsaved changes in the basics section?
    basicsChanged: computed.or('tagsChanged', 'abstractChanged', 'doiChanged', 'licenseChanged', 'originalPublicationDateChanged'),

    ////////////////////////////////////////////////////
    // Fields used in the "discipline" section of the form.
    ////////////////////////////////////////////////////

    // Pending subjects
    subjectsList: computed('model.subjects.@each', function() {
        return this.get('model.subjects') ? $.extend(true, [], this.get('model.subjects')) : A();
    }),

    // Flattened subject list
    disciplineReduced: computed('model.subjects', function() {
        return $.extend(true, [], this.get('model.subjects')).reduce((acc, val) => acc.concat(val), []).uniqBy('id');
    }),

    // Compares the model's and current subjectLists's array of arrays of discipline ids
    // to determine if there has been a change.
    disciplineChanged: computed('model.subjects.@each.subject', 'subjectsList.@each.subject', 'disciplineModifiedToggle', function () {
        return JSON.stringify(subjectIdMap(this.get('model.subjects'))) !== JSON.stringify(subjectIdMap(this.get('subjectsList')));
    }),

    // Returns all contributors of node that will be container for preprint.  Makes sequential requests to API until all pages of contributors have been loaded
    // and combines into one array
    getContributors: observer('node', function() {
        // Cannot be called until a project has been selected!
        if (!this.get('node')) return;

        let node = this.get('node');
        let contributors = A();
        loadAll(node, 'contributors', contributors).then(()=>
             this.set('contributors', contributors));
    }),

    getNodePreprints: observer('node', function() {
        // Returns any existing preprints stored on the current node

        // Cannot be called until a project has been selected!
        const node = this.get('node');
        if (!node) return;

        node.get('preprints').then((preprints) => {
            this.set('existingPreprints', preprints);
            if (preprints.toArray().length > 0) { // If node already has a preprint
                let preprint = preprints.toArray()[0]; // TODO once branded is finished, this will change
                if (!(preprint.get('isPublished'))) { // Preprint exists in abandoned state.
                    this.set('abandonedPreprint', preprint);
                }
            }
        });
    }),

    getParentContributors: observer('parentNode', function() {
        // Returns all contributors of parentNode if component was created.  User later has option to import
        // parentContributors to component.
        let parent = this.get('parentNode');
        let contributors = A();
        loadAll(parent, 'contributors', contributors).then(()=>
            this.set('parentContributors', contributors));
    }),

    // True if the current user has admin permissions
    isAdmin: computed('node', function() {
        return (this.get('node.currentUserPermissions') || []).includes(permissions.ADMIN);
    }),

    // True if the current user is and admin and the node is not a registration.
    canEdit: computed('isAdmin', 'node', function() {
        return this.get('isAdmin') && !(this.get('node.registration'));
    }),

    ///////////////////////////////////////////////////
    // Language about submission and moderation.
    ////////////////////////////////////////////////////

    moderationType: computed.alias('currentProvider.reviewsWorkflow'),
    workflow: computed('moderationType', function () {
        return WORKFLOW[this.get('moderationType')];
    }),
    providerName: computed('currentProvider', function() {
        return this.get('currentProvider.id') !== 'osf' ?
            this.get('currentProvider.name') :
            this.get('i18n').t('global.brand_name');
    }),
    modalTitle: computed('moderationType', function() {
        if (this.get('editMode')) {
            return MODAL_TITLE['resubmit'];
        }
        return this.get('moderationType') === PRE_MODERATION ?
            MODAL_TITLE['submit'] :
            MODAL_TITLE['create'];
    }),

    // submission
    heading: computed('moderationType', function() {
        return this.get('moderationType') === PRE_MODERATION ?
            ACTION['submit']['heading'] :
            ACTION['create']['heading'];
    }),
    buttonLabel: computed('moderationType', function() {
        return this.get('moderationType') === PRE_MODERATION ?
            ACTION['submit']['button'] :
            ACTION['create']['button'];
    }),
    generalInformation: computed('moderationType', function() {
        return this.get('moderationType') ?
            SUBMIT_MESSAGES['moderation'] :
            SUBMIT_MESSAGES['default'];
    }),
    permissionInformation: computed('moderationType', function() {
        return this.get('moderationType') === PRE_MODERATION ?
            PERMISSION_MESSAGES['submit'] :
            PERMISSION_MESSAGES['create'];
    }),
    moderationInformation: computed('moderationType', function() {
        return SUBMIT_MESSAGES[this.get('moderationType')];
    }),

    // edit
    showInformation: computed('moderationType', 'model.reviewsState', function() {
        let state = this.get('model.reviewsState');
        let modType = this.get('moderationType');
        return !(state === ACCEPTED || (modType === POST_MODERATION && state === PENDING));
    }),
    editInformation1: computed('moderationType', function() {
        return EDIT_MESSAGES['line1'][this.get('moderationType')];
    }),
    editInformation2: computed('moderationType', 'model.reviewsState', function() {
        return EDIT_MESSAGES['line2'][this.get('model.reviewsState')][this.get('moderationType')];
    }),
    canResubmit: computed('moderationType', 'model.reviewsState', function() {
        let state = this.get('model.reviewsState');
        return this.get('moderationType') === PRE_MODERATION && (state === PENDING || state === REJECTED);
    }),

    actions: {
        // This gets called by the save method of the license-widget, which in autosave mode
        // gets called every time a change is observed in the widget.
        editLicense(basicsLicense, licenseValid) {
            this.setProperties({
                basicsLicense,
                licenseValid
            });
        },
        applyLicenseToggle(apply) {
            this.set('applyLicense', apply);
            get(this, 'metrics')
                .trackEvent({
                    category: 'radio-button',
                    action: 'select',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Apply License: ${apply}`
                });
        },
        next(currentPanelName) {
            // Open next panel
            if (currentPanelName === 'Upload' || currentPanelName === 'Basics') {
                run.scheduleOnce('afterRender', this, function() {
                    MathJax.Hub.Queue(['Typeset', MathJax.Hub, $(currentPanelName === 'Upload' ? '.preprint-header-preview' : '.abstract')[0]]);  // jshint ignore:line
                });
            }
            if (currentPanelName === 'Authors') {
                get(this, 'metrics')
                    .trackEvent({
                        category: 'button',
                        action: 'click',
                        label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Authors Next Button`
                    });
            }
            this.get('panelActions').open(this.get(`_names.${this.get('_names').indexOf(currentPanelName) + 1}`));
            this.send('changesSaved', currentPanelName);
        },
        nextUploadSection(currentUploadPanel, nextUploadPanel) {
            // Opens next panel within the Upload Section, Existing Workflow (Choose Project - Choose File - Organize - Finalize Upload)
            this.get('panelActions').toggle(currentUploadPanel);
            this.get('panelActions').toggle(nextUploadPanel);
        },
        changesSaved(currentPanelName) {
            // Temporarily changes panel save state to true.  Used for flashing 'Changes Saved' in UI.
            let currentPanelSaveState = currentPanelName.toLowerCase() + 'SaveState';
            this.set(currentPanelSaveState, true);
            run.later(this, () => {
                this.set(currentPanelSaveState, false);
            }, 3000);
        },

        error(error /*, transition */) {
            this.get('toast').error(error);
        },
        /*
          Upload section
         */
        changeInitialState(newState) {
            // Sets filePickerState to start, new, or existing - this is the initial decision on the form.
            this.set('filePickerState', newState);
            this.send('clearDownstreamFields', 'allUpload');
            if (newState === this.get('_State').NEW) {
                get(this, 'metrics')
                    .trackEvent({
                        category: 'button',
                        action: 'click',
                        label: 'Submit - Upload new preprint'
                    });
            } else if (newState === this.get('_State').EXISTING) {
                this.get('panelActions').open('chooseProject');
                this.get('panelActions').close('selectExistingFile');
                this.get('panelActions').close('uploadNewFile');
                this.get('panelActions').close('organize');
                this.get('panelActions').close('finalizeUpload');
                get(this, 'metrics')
                    .trackEvent({
                        category: 'button',
                        action: 'click',
                        label: 'Submit - Connect preprint to existing OSF Project'
                    });
            } else {
                get(this, 'metrics')
                    .trackEvent({
                        category: 'button',
                        action: 'click',
                        label: 'Submit - Back Button, Upload Section'
                    });
            }
        },
        finishUpload() {
            // Locks node so that preprint location cannot be modified.  Occurs after upload step is complete.
            // In editMode, nodeLocked is set to true.
            // Locks node and advances to next form section.
            this.setProperties({
                nodeLocked: true,
                file: null
            });
            // Closes section, so all panels closed if Upload section revisited
            this.get('panelActions').close('uploadNewFile');
            this.send('next', this.get('_names.1'));
        },
        existingNodeExistingFile() {
            // Upload case for using existing node and existing file for the preprint.  If title has been edited, updates title.
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: 'Submit - Save and Continue, Existing Node Existing File'
                });

            const model = this.get('model');
            const node = this.get('node');
            const currentNodeTitle = node.get('title');
            const title = this.get('title');

            this.set('basicsAbstract', this.get('model.description') || null);

            return Promise.resolve()
                .then(() => {
                    if (currentNodeTitle === title) {
                        return;
                    }
                    model.set('title', title);
                    node.set('title', title);
                    return node.save();
                })
                .then(() => this.send(this.get('abandonedPreprint') ? 'resumeAbandonedPreprint' : 'startPreprint'))
                .catch(() => {
                    node.set('title', currentNodeTitle);
                    this.get('toast').error(
                        this.get('i18n').t('submit.could_not_update_title')
                    );
                });
        },
        createComponentCopyFile() {
            // Upload case for using a new component and an existing file for the preprint. Creates a component and then copies
            // file from parent node to new component.
            let node = this.get('node');
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: 'Submit - Save and Continue, New Component, Copy File'
                });
            node.addChild(this.get('title'))
                .then(child => {
                    this.set('parentNode', node);
                    this.set('node', child);
                    this.set('basicsAbstract', this.get('node.description') || null);
                    child.get('files')
                        .then((providers) => {
                            let osfstorage = providers.findBy('name', 'osfstorage');
                            this.get('fileManager').copy(this.get('selectedFile'), osfstorage, {data: {resource: child.id}})
                                .then((copiedFile) => {
                                    this.set('selectedFile', copiedFile);
                                    this.send('startPreprint', this.get('parentNode'));
                                    this.set('applyLicense', true);
                                    this.set('newNode', true);
                                })
                                .catch(() => this.get('toast').error(this.get('i18n').t('submit.error_copying_file')));
                        })
                        .catch(() => {
                            this.get('toast').error(this.get('i18n').t('submit.error_accessing_parent_files'));
                        });
                })
                .catch(() => {
                    this.get('toast').error(this.get('i18n').t('submit.could_not_create_component'));
                });

        },
        resumeAbandonedPreprint() {
            // You can only have one preprint per provider. For now, we delete the abandoned preprint so another preprint can be created.
            let preprintRecord = this.store.peekRecord('preprint', this.get('abandonedPreprint').id);
            preprintRecord.destroyRecord()
                .then(() => {
                    this.send('startPreprint');
                })
                .catch(() => {
                    this.get('toast').error(this.get('i18n').t('submit.abandoned_preprint_error'));
                });
        },
        startPreprint(parentNode) {
            // Initiates preprint.  Occurs in Upload section of Add Preprint form when pressing 'Save and continue'.  Creates a preprint with
            // primaryFile, node, and provider fields populated.
            let model = this.get('model');
            this.get('node.license').then(license => {
                //This is used to set the default applyLicense once a node is loaded, as if the node's
                //license is not set or is of type No license, we want to set the default to make its license the same
                //as the preprint license.
                if (license === null || license && license.get('name').includes('No license')) {
                    this.set('applyLicense', true);
                }
            });

            model.set('primaryFile', this.get('selectedFile'));
            model.set('node', this.get('node'));
            model.set('provider', this.get('currentProvider'));

            return model.save()
                .then(() => {
                    this.set('filePickerState', State.EXISTING); // Sets upload form state to existing project (now that project has been created)
                    this.set('existingState', existingState.NEWFILE); // Sets file state to new file, for edit mode.
                    this.set('file', null);
                    this.get('toast').info(this.get('i18n').t('submit.preprint_file_uploaded'));
                    this.send('finishUpload');
                })
                .catch(() => {
                    this.set('uploadInProgress', false); // Setting to false allows user to attempt operation again.
                    if (parentNode) { // If creating preprint failed after a component was created, set the node back to the parentNode.
                        // If user tries to initiate preprint again, a separate component will be created under the parentNode.
                        this.set('node', parentNode);
                    }
                    this.get('toast').error(this.get('i18n').t('submit.error_initiating_preprint'));
                });
        },

        // Takes file chosen from file-browser and sets equal to selectedFile. This file will become the preprint.
        selectExistingFile(file) {
            this.set('selectedFile', file);
        },

        // Discards upload section changes.  Restores displayed file to current preprint primaryFile
        // and resets displayed title to current node title. (No requests sent, front-end only.)
        discardUploadChanges() {
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Discard Upload Changes`
                });

            this.setProperties({
                file: null,
                selectedFile: this.get('store').peekRecord('file', this.get('model.primaryFile.id')),
                title: this.get('model.title'),
                titleValid: true,
            });
        },

        //If user goes back and changes a section inside Upload, all fields downstream of that section need to clear.
        clearDownstreamFields(section) {
            // Only clear downstream fields in Add mode!
            if (this.get('nodeLocked'))
                return;

            const props = [];

            /* eslint no-fallthrough: 0 */
            switch (section) {
                case 'allUpload':
                    props.push('node');
                case 'belowNode':
                    props.push('selectedFile', 'file');
                case 'belowFile':
                    props.push('convertOrCopy');
                case 'belowConvertOrCopy':
                    props.push('title');
                    break;
            }

            const mergeObj = {};

            for (const prop of props)
                mergeObj[prop] = null;

            this.setProperties(mergeObj);
        },
        /*
          Basics section
         */
        discardBasics() {
            // Discards changes to basic fields. (No requests sent, front-end only.)
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Discard Basics Changes`
                });
            this.set('basicsTags', this.get('model.tags').slice(0).map(fixSpecialChar));
            this.set('basicsAbstract', this.get('model.description'));
            this.set('basicsDOI', this.get('model.doi'));
            this.set('basicsOriginalPublicationDate', this.get('model.originalPublicationDate'));
            let date = new Date();
            this.get('model.license').then(license => {
                this.set('basicsLicense', {
                    licenseType: license || this.get('availableLicenses').toArray()[0],
                    year: this.get('model.licenseRecord') ? this.get('model.licenseRecord').year : date.getUTCFullYear().toString(),
                    copyrightHolders: this.get('model.licenseRecord') ? this.get('model.licenseRecord').copyright_holders.join(', ') : ''
                });
            });
        },
        preventDefault(e) {
            e.preventDefault();
        },
        stripDOI() {
            // Replaces the inputted doi link with just the doi itself
            get(this, 'metrics')
                .trackEvent({
                    category: 'input',
                    action: 'onchange',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - DOI Text Change`
                });
            let basicsDOI = this.get('basicsDOI');
            this.set('basicsDOI', extractDoiFromString(basicsDOI));
        },
        saveBasics() {
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Save and Continue Basics Section`
                });
            // Saves the description/tags on the node and the DOI on the preprint, then advances to next panel
            if (!this.get('basicsValid')) {
                return;
            }

            const node = this.get('node');
            const model = this.get('model');
            // Saves off current server-state basics fields, so UI can be restored in case of failure
            const currentAbstract = model.get('description');
            const currentTags = model.get('tags').slice();
            const currentDOI = model.get('doi');
            const currentOriginalPublicationDate = model.get('originalPublicationDate');
            const currentLicenseType = model.get('license');
            const currentLicenseRecord = model.get('licenseRecord');
            const currentNodeLicenseType = node.get('license');
            const currentNodeLicenseRecord = node.get('nodeLicense');
            const copyrightHolders = this.get('basicsLicense.copyrightHolders')
                .split(', ')
                .map(item => item.trim());

            if (this.get('abstractChanged'))
                model.set('description', this.get('basicsAbstract'));

            if (this.get('tagsChanged'))
                model.set('tags', this.get('basicsTags'));

            if (this.get('applyLicense')) {
                if (node.get('nodeLicense.year') !== this.get('basicsLicense.year') || (node.get('nodeLicense.copyrightHolders') || []).join() !== copyrightHolders.join()) {
                    node.set('nodeLicense', {
                        year: this.get('basicsLicense.year'),
                        copyright_holders: copyrightHolders
                    });
                }

                if (node.get('license.name') !== this.get('basicsLicense.licenseType.name')) {
                    node.set('license', this.get('basicsLicense.licenseType'));
                }
            }

            if (this.get('doiChanged')) {
                model.set('doi', this.get('basicsDOI') || null);
            }

            if (this.get('originalPublicationDateChanged')) {
                model.set('originalPublicationDate', this.get('basicsOriginalPublicationDate') || null);
            }

            if (this.get('licenseChanged') || !this.get('model.license.name')) {
                model.setProperties({
                    licenseRecord: {
                        year: this.get('basicsLicense.year'),
                        copyright_holders: copyrightHolders
                    },
                    license: this.get('basicsLicense.licenseType')
                });
                get(this, 'metrics')
                    .trackEvent({
                        category: 'dropdown',
                        action: 'select',
                        label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Edit License`
                    });
            }

            const saveOriginalValues = () => {
                model.setProperties({
                    licenseRecord: currentLicenseRecord,
                    license: currentLicenseType,
                    doi: currentDOI,
                    originalPublicationDate: currentOriginalPublicationDate,
                });

                node.setProperties({
                    description: currentAbstract,
                    tags: currentTags,
                    license: currentNodeLicenseType,
                    nodeLicense: currentNodeLicenseRecord,
                });

                node.save().then(() => model.save());
            };

            node.save()
                .then(() => model.save()
                    .then(() => this.send('next', this.get('_names.3')))
                    .catch(() => {
                        // If model save fails, do not transition, save original vales
                        this.get('toast').error(
                            this.get('i18n').t('submit.basics_error')
                        );
                        saveOriginalValues();
                    })
                )
                .catch(() => {
                    // If node save fails, do not transition, save original values
                    this.get('toast').error(
                        this.get('i18n').t('submit.basics_error')
                    );
                    saveOriginalValues();
                });
        },

        // Custom addATag method that appends tag to list instead of auto-saving
        addTag(tag) {
            get(this, 'metrics')
                .trackEvent({
                    category: 'input',
                    action: 'onchange',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Add Tag`
                });

            this.get('basicsTags').pushObject(tag);
        },

        // Custom removeATag method that removes tag from list instead of auto-saving
        removeTag(index) {
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Remove Tag`
                });

            this.get('basicsTags').removeAt(index);
        },

        /*
          Discipline section
        */

        discardSubjects() {
            // Discards changes to subjects. (No requests sent, front-end only.)
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Discard Discipline Changes`
                });
            this.set('subjectsList', $.extend(true, [], this.get('model.subjects')));
        },

        saveSubjects(hasChanged) {
            // Saves subjects (disciplines) and then moves to next section.
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Discipline Save and Continue`
                });

            const sendNext = () => this.send('next', this.get('_names.2'));

            if (!hasChanged) {
                return sendNext();
            }

            const model = this.get('model');

            model.set('subjects', subjectIdMap(this.get('subjectsList')));
            model.save()
                .then(sendNext)
                .catch(() => {
                    // Current subjects saved so UI can be restored in case of failure
                    model.set('subjects', $.extend(true, [], this.get('model.subjects')));
                    this.get('toast').error(this.get('i18n').t('submit.disciplines_error'));
                });
        },
        /**
         * findContributors method.  Queries APIv2 users endpoint on any of a set of name fields.  Fetches specified page of results.
         *
         * @method findContributors
         * @param {String} query ID of user that will be a contributor on the node
         * @param {Integer} page Page number of results requested
         * @return {User[]} Returns specified page of user records matching query
         */
        findContributors(query, page) {
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit' : 'Submit'} - Search for Authors`
                });
            return this.store.query('user', {
                filter: {
                    'full_name,given_name,middle_names,family_name': query
                },
                page: page
            }).then((contributors) => {
                this.set('searchResults', contributors);
                return contributors;
            }).catch(() => {
                this.get('toast').error(this.get('i18n').t('submit.search_contributors_error'));
                this.highlightSuccessOrFailure('author-search-box', this, 'error');
            });
        },
        /**
        * highlightSuccessOrFailure method. Element with specified ID flashes green or red depending on response success.
        *
        * @method highlightSuccessOrFailure
        * @param {string} elementId Element ID to change color
        * @param {Object} context "this" scope
        * @param {string} status "success" or "error"
        */
        highlightSuccessOrFailure(elementId, context, status) {
            const highlightClass = `${status === 'success' ? 'success' : 'error'}Highlight`;

            context.$('#' + elementId).addClass(highlightClass);

            run.later(() => context.$('#' + elementId).removeClass(highlightClass), 2000);
        },
        /*
          Submit tab actions
         */
        clickSubmit() {
            if (this.get('allSectionsValid')) {
                // Toggles display of share preprint modal
                get(this, 'metrics')
                    .trackEvent({
                        category: 'button',
                        action: 'click',
                        label: 'Submit - Open Share Preprint Modal'
                    });
                this.toggleProperty('showModalSharePreprint');
            } else {
                get(this, 'metrics')
                    .trackEvent({
                        category: 'button',
                        action: 'click',
                        label: 'Submit - Display validation errors'
                    });
                this.set('attemptedSubmit', true);
            }
        },
        savePreprint() {
            // Finalizes saving of preprint.  Publishes preprint and turns node public.
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `${this.get('editMode') ? 'Edit - Complete Preprint Edits' : 'Submit - Share Preprint'}`
                });

            const model = this.get('model');
            const node = this.get('node');
            this.set('savingPreprint', true);
            this.toggleProperty('shareButtonDisabled');
            model.set('provider', this.get('currentProvider'));

            let submitAction = null;
            if (this.get('moderationType')) {
                submitAction = this.get('store').createRecord('review-action', {
                   actionTrigger: 'submit',
                   target: this.get('model')
                });
            } else {
                model.set('isPublished', true);
            }
            node.set('public', true);

            let save_changes = null;
            if (submitAction) {
                save_changes = model.save().then(() => node.save()).then(() => submitAction.save());
            } else {
                save_changes = model.save().then(() => node.save());
            }

            return save_changes
                .then(() => {
                        this.set('preprintSaved', true);
                        let useProviderRoute = false;
                        if (this.get('theme.isProvider')) {
                            useProviderRoute = this.get('theme.isSubRoute');
                        } else if (this.get('currentProvider.domain') && this.get('currentProvider.domainRedirectEnabled')) {
                            window.location.replace(`${this.get('currentProvider.domain')}${model.id}`);
                        } else if (this.get('currentProvider.id') !== 'osf') {
                            useProviderRoute = true;
                        }
                        this.transitionToRoute(
                            `${useProviderRoute ? 'provider.' : ''}content`,
                            model.reload()
                        );
                })
                .catch(() => {
                    this.toggleProperty('shareButtonDisabled');
                    return this.get('toast')
                        .error(this.get('i18n')
                            .t(`submit.error_${this.get('editMode') ? 'completing' : 'saving'}_preprint`)
                        );
                });
        },
        cancel() {
            this.transitionToRoute('index');
        },
        resubmit() {
            this.set('savingPreprint', true);
            this.toggleProperty('shareButtonDisabled');

            let submitAction = this.get('store').createRecord('review-action', {
                actionTrigger: 'submit',
                target: this.get('model')
            });

            return submitAction.save()
                .then(() => {
                    this.set('preprintSaved', true);
                    this.get('model').reload();
                    this.transitionToRoute(
                        `${this.get('theme.isSubRoute') ? 'provider.' : ''}content`,
                        this.get('model')
                    );
                })
                .catch(() => {
                    this.toggleProperty('shareButtonDisabled');
                    return this.get('toast')
                        .error(this.get('i18n')
                            .t(`submit.error_${this.get('editMode') ? 'completing' : 'saving'}_preprint`)
                        );
                });
        },
        returnToSubmission() {
            this.transitionToRoute(
                `${this.get('theme.isSubRoute') ? 'provider.' : ''}content`,
                this.get('model')
            );
        },
        selectProvider(provider) {
            this.set('selectedProvider', provider);
            this.set('providerChanged', true);
        },
        saveProvider() {
            this.set('currentProvider', this.get('selectedProvider'));
            this.get('currentProvider').queryHasMany('licensesAcceptable', {'page[size]': 20}).then(licenses => {
                this.set('availableLicenses', licenses);
                this.set('basicsLicense.licenseType', this.get('availableLicenses.firstObject'));
            });
            this.set('providerChanged', false);
            this.set('providerSaved', true);
            this.send('discardSubjects');
            this.send('next', this.get('_names.0'));
            get(this, 'metrics')
                .trackEvent({
                    category: 'button',
                    action: 'click',
                    label: `Submit - Save and continue, Select ${this.get('currentProvider.name')} preprint service`
                });
        },
        discardProvider() {
            this.set('selectedProvider', this.get('currentProvider'));
            this.set('providerChanged', false);
        }
    }
});
