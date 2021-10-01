/* eslint-disable no-multi-str */
const functions = require("firebase-functions");

// The Firebase Admin SDK to access Firestore.
const admin = require("firebase-admin");
admin.initializeApp();

// Mail
const nodemailer = require("nodemailer");
const { google } = require("googleapis");
const OAuth2 = google.auth.OAuth2;

// General exceptions
const authenticationError = () =>
  new functions.https.HttpsError(
    "unauthenticated",
    "Sorry, we need you to be signed in to do this.",
  );
const verifiedError = () =>
  new functions.https.HttpsError(
    "unauthenticated",
    "Sorry, to ensure privacy we need to verify your email before you can do this.",
  );
const parametersError = (id) =>
  new functions.https.HttpsError(
    "invalid-argument",
    "Sorry, no parameters were provided to the server.",
  );
const existError = (id) =>
  new functions.https.HttpsError(
    "invalid-argument",
    `Sorry, the activity (ID: ${id}) doesn't exist. It might've been deleted.`,
  );
const accessError = () =>
  new functions.https.HttpsError(
    "unauthenticated",
    "Sorry, you do not have access to this activity. If you previously did, somebody probably removed your access.",
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

/**
 * Sends an email
 */
const sendEmail = async (to, subject, message) => {
  // Initialise connection
  const oauth2Client = new OAuth2(
    functions.config().gmail.clientid,
    functions.config().gmail.clientsecret,
    "https://developers.google.com/oauthplayground",
  );
  oauth2Client.setCredentials({
    refresh_token: functions.config().gmail.refreshtoken,
  });
  const accessToken = oauth2Client.getAccessToken();
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      type: "OAuth2",
      user: functions.config().gmail.user,
      clientId: functions.config().gmail.clientid,
      clientSecret: functions.config().gmail.clientsecret,
      refreshToken: functions.config().gmail.refreshtoken,
      accessToken: accessToken,
    },
  });

  // Format message
  const template = `<!DOCTYPE html> <html lang="en"> <head> <meta content="width=device-width" name="viewport"> <meta content="text/html; charset=utf-8" http-equiv="Content-Type"> <title>AMS - Scouts Aotearoa</title> <style> @media all { .ExternalClass { width: 100%; } .ExternalClass, .ExternalClass p, .ExternalClass span, .ExternalClass font, .ExternalClass td, .ExternalClass div { line-height: 100%; } .apple-link a { color: inherit !important; font-family: inherit !important; font-size: inherit !important; font-weight: inherit !important; line-height: inherit !important; text-decoration: none !important; } #MessageViewBody a { color: inherit; text-decoration: none; font-size: inherit; font-family: inherit; font-weight: inherit; line-height: inherit; } } </style> </head> <body style="background: #fafafa;margin: 0;padding: 1rem;font-family: Verdana, sans-serif;"> <table border="0" cellpadding="0" cellspacing="0" class="body" role="presentation" style="max-width: 30rem;width: 100%;margin: 0 auto;"> <tbody> <tr> <td style="background-color: #5f249f;padding: 1rem;border-radius: 0.5rem 0.5rem 0 0;"> <img src="https://ams-scouts-aotearoa.web.app/img/email.png" alt="AMS - Scouts Aotearoa Logo" style="display: block;margin: 0 auto;font-weight: bold;width: 100%;max-width: 20rem;color: #ffffff;text-align: center;"> </td> </tr> <tr> <td style="background-color: #ffffff;padding: 1rem;border-radius: 0 0 0.5rem 0.5rem">
      <p>${message.join("</p> <p>")}</p>
    </td> </tr> <tr> <td style="padding: 1rem;text-align: center;font-size: 0.8rem;color: rgb(150, 150, 150);"> You received this email because of an action somebody took in AMS.<br> Scouts Aotearoa, 1 Kaiwharawhara Road, Kaiwharawhara, Wellington 6035, New Zealand. </td> </tr> </tbody> </table> </body></html>`;

  return transporter.sendMail({
    to: to,
    subject: subject,
    text: message.join("\n\n"),
    html: template,
    from: `"Activity Management System - Scouts Aotearoa" <${functions.config().gmail.user}>`,
  });
};

exports.activityPlannerGetActivities = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated
    if (!context.auth.token.email_verified) throw verifiedError(); // Ensure user's email is verified

    const uid = context.auth.uid;
    const email = context.auth.token.email;

    // Database path of records
    const emailPath = `peopleByEmail.${email.replace(/\./g, "&period;")}`;
    const uidPath = `peopleByUID.${uid}`;

    if (context.auth.token.email_verified) {
      // If verified, check any peopleByEmail records exist

      const emailActivities = await admin
        .firestore()
        .collection("activities")
        .where(emailPath, "in", [
          "Activity Leader",
          "Assisting",
          "Editor",
          "Viewer"],
        ).get();

      // Activities that are assigned to the user by email, not UID
      await emailActivities.docs.forEach(
        async (activity) => {
          // Switch peopleByEmail entry to peopleByUID
          await admin.firestore()
            .collection("activities")
            .doc(activity.id)
            .update({
              [emailPath]: admin.firestore.FieldValue.delete(),
              [uidPath]: activity.data().peopleByEmail[email],
            });
        },
      );
    }

    // Get all activities assigned by UID
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
    if (!context.auth.token.email_verified) throw verifiedError(); // Ensure user's email is verified
    if (!data) throw parametersError(); // Ensure parameters have been provided

    // Define document
    const fields = [
      {
        name: "name",
        value: data?.name,
        rules: [RULES.defined, RULES.string],
      },
    ];

    // Ensure all fields meet their rules
    checkRules(fields);

    // Sort out data to write to firestore
    const documentTemplate = {
      name: data.name,
      location: "",
      startDate: "",
      startTime: "",
      endDate: "",
      endTime: "",
      peopleByUID: { [context.auth.uid]: "Editor" },
      peopleByEmail: {},
    };

    // Add document to database
    const { id } = await admin
      .firestore()
      .collection("activities")
      .add(documentTemplate);

    return { id: id };
  });

// Gets the overview data of an activity
exports.activityOverviewGet = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated
    if (!context.auth.token.email_verified) throw verifiedError(); // Ensure user's email is verified
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
    if (!(context.auth.uid in activity.data().peopleByUID)) throw accessError();

    // Prepare neccessary data
    const returnData = Object.fromEntries(
      ["name", "location", "startDate", "startTime", "endDate", "endTime"].map(
        (name) => [name, activity.data()[name]],
      ),
    );

    // Include the current user's role
    returnData.role = activity.data().peopleByUID[context.auth.uid];

    return returnData;
  });

// Sets overview data for an activity
exports.activityOverviewSet = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated
    if (!context.auth.token.email_verified) throw verifiedError(); // Ensure user's email is verified
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
    if (!(context.auth.uid in activity.data().peopleByUID)) throw accessError(); // No access

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

// Gets the people data of an activity
exports.activityPeopleGet = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated
    if (!context.auth.token.email_verified) throw verifiedError(); // Ensure user's email is verified
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
    if (!(context.auth.uid in activity.data().peopleByUID)) throw accessError();

    // Prepare neccessary data
    const returnData = Object.fromEntries(
      ["peopleByUID", "peopleByEmail"].map((name) => [
        name,
        activity.data()[name],
      ]),
    );

    // ,,Prepare user information
    const users = await admin
      .auth()
      .getUsers(
        Object.keys(returnData.peopleByUID).map((uid) => ({ uid: uid })),
      );

    returnData.infoByUID = Object.fromEntries(
      users.users.map((user) => [
        user.uid,
        {
          displayName: user.displayName,
          email: user.email,
          photoURL: user.photoURL,
        },
      ]),
    ); // {uid: ,,displayName, email, photoURL}}

    return returnData;
  });

// Adds a person to an activity, or otherwise updates their role. Removing a role removes access.
exports.activityPeopleUpdate = functions
  .region("australia-southeast1")
  .https.onCall(async (data, context) => {
    if (!context.auth) throw authenticationError(); // Ensure user is authenticated
    if (!context.auth.token.email_verified) throw verifiedError(); // Ensure user's email is verified
    if (!data) throw parametersError(); // Ensure parameters have been provided
    if (!data.id) throw existError(data.id); // Ensure activity id is given

    // Check arguments
    const fields = [
      {
        name: "email",
        value: data?.email,
        rules: [
          RULES.defined,
          RULES.string,
          {
            condition: (v) => v == null || /.+@.+/.test(v),
            exception: (argumentName) =>
              new functions.https.HttpsError(
                "invalid-argument",
                `The argument ${argumentName} must be a valid email.`,
              ),
          },
        ],
      },
      {
        name: "role",
        value: data?.role,
        rules: [
          RULES.string,
          {
            condition: (v) =>
              v == null ||
              ["Activity Leader", "Assisting", "Editor", "Viewer"].includes(v),
            exception: (argumentName) =>
              new functions.https.HttpsError(
                "invalid-argument",
                `The argument ${argumentName} is not valid.`,
              ),
          },
        ],
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
    if (!(context.auth.uid in activity.data().peopleByUID)) throw accessError(); // No access

    // Get user information
    const users = await admin.auth().getUsers([{ email: data.email }]);

    const documentPath = users.users.length ?
      ["peopleByUID", users.users[0].uid] :
      ["peopleByEmail", data.email.replace(/\./g, "&period;")];

    // Count people with editing access who currently have accounts
    if (
      documentPath[0] === "peopleByUID" &&
      (data.role == null || data.role === "Viewer") &&
      activity.data().peopleByUID[users.users[0].uid] !== "Viewer"
    ) {
      // Trying to delete person with current account with editing permissions
      const editingUsers = Object.values(activity.data().peopleByUID).filter(
        (role) => ["Activity Leader", "Assisting", "Editor"].includes(role),
      ).length;

      if (editingUsers <= 1) {
        // Only one person with current account
        throw new functions.https.HttpsError(
          "invalid-argument",
          "Sorry, at least one person with an AMS account must always have editor access or above.",
        );
      }
    }

    // Set data
    await admin
      .firestore()
      .collection("activities")
      .doc(data.id)
      .update(
        new admin.firestore.FieldPath(...documentPath),
        data.role ?? admin.firestore.FieldValue.delete(),
      );

    // Notify user of change
    if (data.role && users.users[0]?.uid !== context.auth.uid) {
      // Changed another user's role, not deleted
      const messageText = [
        `Hi, ${users.users[0]?.displayName ?? data.email}.`,
        `You have been assigned to the role of ${data.role} for the activity ${activity.data().name}. You can find this activity here:`,
        `https://ams-scouts-aotearoa.web.app/activity/${data.id}/people`,
        "Ngā mihi.",
      ];

      const message = sendEmail(
        data.email,
        `Your role of ${data.role} for ${activity.data().name}`,
        messageText,
      );
      console.log(message);
    }

    // Give details for new user
    const returnData = { infoByUID: {} };

    if (users.users.length) {
      // Add person's account details
      const user = users.users[0];
      returnData.infoByUID[user.uid] = {
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
      };

      // Add user role
      returnData.peopleByUID = { [users.users[0].uid]: data.role };
    } else {
      // Person has no AMS account
      returnData.peopleByEmail = { [data.email]: data.role };
    }

    return returnData;
  });
