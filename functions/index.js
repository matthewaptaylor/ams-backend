/* eslint-disable no-multi-str */
const functions = require("firebase-functions");

// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");
admin.initializeApp();

// General exceptions
const authenticationError = () =>
  new functions.https.HttpsError(
    "unauthenticated",
    "The function must be called while authenticated.",
  );
const parametersError = (id) =>
  new functions.https.HttpsError(
    "invalid-argument",
    "No parameters have been provided.",
  );
const existError = (id) =>
  new functions.https.HttpsError(
    "invalid-argument",
    `The activity ${id} doesn't exist.`,
  );
const accessError = () =>
  new functions.https.HttpsError(
    "unauthenticated",
    "You do not have access to this activity.",
  );

// Rules
const RULES = {
  defined: {
    condition: (v) => !!v,
    exception: (argumentName) =>
      new functions.https.HttpsError(
        "invalid-argument",
        `The argument ${argumentName} is undefined.`,
      ),
  },
  string: {
    condition: (v) => v == null || typeof v === "string",
    exception: (argumentName) =>
      new functions.https.HttpsError(
        "invalid-argument",
        `The argument ${argumentName} is not a string.`,
      ),
  },
  number: {
    condition: (v) => v == null || typeof v === "number",
    exception: (argumentName) =>
      new functions.https.HttpsError(
        "invalid-argument",
        `The argument ${argumentName} is not a number.`,
      ),
  },
  array: {
    condition: (v) => v == null || Array.isArray(v),
    exception: (argumentName) =>
      new functions.https.HttpsError(
        "invalid-argument",
        `The argument ${argumentName} is not an array.`,
      ),
  },
  peopleArray: {
    // Checks that the array submitted contains objects with the keys email and role
    condition: (v) =>
      v == null ||
      v.every(
        (person) =>
          /.+@.+/.test(person.email) &&
          ["Activity Leader", "Assisting", "Editor", "Viewer"].includes(
            person.role,
          ),
      ),
    exception: (argumentName) =>
      new functions.https.HttpsError(
        "invalid-argument",
        `The argument ${argumentName} must contain objects with valid email and role properties.`,
      ),
  },
};

/**
 * Checks that every field conforms to given rules, and throws an exception if it doesn't
 * @param {Object[]} fields The fields that need to be checked.
 * @param {string} fields[].name The name of a field.
 * @param {string} fields[].value The value of a field.
 * @param {Object[]} [fields[].rules] The set of rules to check the value against.Function
 * @param {Function} fields[].rules[].condition Function that returns a boolean of if the rule has
 * been met, taking the field value as input.
 * @param {Function} fields[].rules[].exception Function that returns an exception for if the
 * condition has not been met, taking the field name as input
 * @param {boolean} [preventException = false] Whether to prevent throwing an exception if a
 * condition has not been met.
 * @return {boolean} If all of the conditions were met.
 */
const checkRules = (fields, preventException = false) => {
  fields.forEach((field) => {
    (field.rules ?? []).forEach((rule) => {
      // Check each rule in each field
      if (!rule.condition(field.value)) {
        // Value does not meet rule condition, throw rule's exception
        if (!preventException) throw rule.exception(field.name);

        return false;
      }
    });
  });

  return true;
};

exports.activityPlannerGetActivities = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated

    const uid = context.auth.uid;

    const activities = await admin
      .firestore()
      .collection("activities")
      .where(`peopleByUID.${uid}`, "in", [
        "Activity Leader",
        "Assisting",
        "Editor",
        "Viewer",
      ])
      .get();

    return activities.docs.map((activity) => ({
      id: activity.id,
      name: activity.data().name,
      role: activity.data().peopleByUID[uid],
    }));
  });

exports.activityPlannerCreateActivity = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated

    // Define document
    const fields = [
      {
        name: "name",
        value: data?.name,
        rules: [RULES.defined, RULES.string],
      },
      {
        name: "location",
        value: data?.location,
        rules: [RULES.string],
      },
      {
        name: "startDate",
        value: data?.startDate,
        rules: [RULES.string],
      },
      {
        name: "startTime",
        value: data?.startTime,
        rules: [RULES.string],
      },
      {
        name: "endDate",
        value: data?.startDate,
        rules: [RULES.string],
      },
      {
        name: "endTime",
        value: data?.startTime,
        rules: [RULES.string],
      },
    ];

    // Ensure all fields meet their rules
    checkRules(fields);

    // Write each field with a value into a template that can be inserted into Firestore
    const documentTemplate = {};
    fields.forEach((field) => {
      if (field.value != null && field.value !== "") {
        documentTemplate[field.name] = field.value;
      }
    });

    // Check that there is exactly one activity leader
    if (
      data.people.filter((person) => person.role === "Activity Leader")
        .length !== 1
    ) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "There must be one Activity Leader.",
      );
    }

    // Convert people into two values that can be stored in firestore,
    // peopleUID and peopleEmail (to store users not yet signed up).

    // Check people array is valid
    [RULES.defined, RULES.array, RULES.peopleArray].forEach((rule) => {
      if (!rule.condition(data.people)) throw rule.exception("people");
    });

    documentTemplate.peopleByUID = {};
    documentTemplate.peopleByEmail = {};

    await admin
      .auth()
      .getUsers(
        data.people.map((person) => {
          return { email: person.email };
        }),
      )
      .then((users) => {
        // Add people who are users to peopleByUID
        users.users.forEach((user) => {
          // Add uid: role key value pair to peopleByUID
          documentTemplate.peopleByUID[user.uid] = data.people.find(
            (person) => person.email === user.email,
          ).role;
        });

        // Add people who are not users
        users.notFound.forEach((user) => {
          // Add email: role key value pair to peopleByEmail
          documentTemplate.peopleByEmail[user.email] = data.people.find(
            (person) => person.email === user.email,
          ).role;
        });
      });

    // Check that at least one person with an account has editing access
    if (
      !Object.values(documentTemplate.peopleByUID).some((role) =>
        ["Activity Leader", "Editor", "Assisting"].includes(role),
      )
    ) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "At least one person with either an Activity Leader, Editor or Assisting role must \
        currently have an account.",
      );
    }

    // Add document to database
    const { id } = await admin
      .firestore()
      .collection("activities")
      .add(documentTemplate);

    return { id: id };
  });

exports.getUsersByEmail = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated

    // Check input
    if (!data.emails) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "The argument emails is undefined.",
      );
    }

    if (!Array.isArray(data.emails)) {
      throw new functions.https.HttpsError(
        "invalid-argument",
        "The argument emails is not an array.",
      );
    }

    const users = await admin
      .auth()
      .getUsers(data.emails.map((email) => ({ email: email })));

    return [
      ...users.users.map((user) => ({
        userExists: true,
        email: user.email,
        displayName: user.displayName,
        photoURL: user.photoURL,
      })),
      ...users.notFound.map((user) => ({
        userExists: false,
        email: user.email,
      })),
    ];
  });

exports.activityOverviewGet = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated
    if (!data) throw parametersError(); // Ensure parameters have been provided
    if (!data?.id) throw existError(data.id); // Ensure activity id is given

    // Get activity
    const activity = await admin
      .firestore()
      .collection("activities")
      .doc(data.id)
      .get();

    if (!activity.exists) throw existError(data.id); // Check activity exists

    // Check user has access to activity
    if (!Object.keys(activity.data().peopleByUID).includes(context.auth.uid)) {
      throw accessError();
    }

    return Object.fromEntries(
      ["name", "location", "startDate", "startTime", "endDate", "endTime"].map(
        (name) => [name, activity.data()[name]],
      ),
    );
  });

exports.activityOverviewSet = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated
    if (!data) throw parametersError(); // Ensure parameters have been provided
    if (!data.id) throw existError(data.id); // Ensure activity id is given

    // Check arguments
    const fields = [
      {
        name: "name",
        value: data?.name,
        rules: [RULES.string],
      },
      {
        name: "location",
        value: data?.location,
        rules: [RULES.string],
      },
      {
        name: "startDate",
        value: data?.startDate,
        rules: [RULES.string],
      },
      {
        name: "startTime",
        value: data?.startTime,
        rules: [RULES.string],
      },
      {
        name: "endDate",
        value: data?.endDate,
        rules: [RULES.string],
      },
      {
        name: "endTime",
        value: data?.endTime,
        rules: [RULES.string],
      },
    ];
    checkRules(fields);

    // Check activity
    const activity = await admin
      .firestore()
      .collection("activities")
      .doc(data.id)
      .get();

    if (!activity.exists) throw existError(data.id); // Activity doesn't exist
    if (!Object.keys(activity.data().peopleByUID).includes(context.auth.uid)) {
      throw accessError();
    } // No access

    // Sort out data to write to firestore
    const documentTemplate = Object.fromEntries(
      fields.map((field) =>
        field.value === undefined ? [] : [field.name, field.value],
      ),
    );
    delete documentTemplate.undefined;

    // Enforce required for name if exists
    if ("name" in documentTemplate && !documentTemplate.name.trim()) {
      throw RULES.defined.exception("name");
    }

    // Set data
    await admin
      .firestore()
      .collection("activities")
      .doc(data.id)
      .update(documentTemplate);

    return true;
  });
