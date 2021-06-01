const functions = require('firebase-functions');
const admin = require('firebase-admin');
const moment = require('moment');

admin.initializeApp(functions.config().firestore);

// // Create and Deploy Your First Cloud Functions
// // https://firebase.google.com/docs/functions/write-firebase-functions
//
// exports.helloWorld = functions.https.onRequest((request, response) => {
//   functions.logger.info('Hello logs!', {structuredData: true});
//   response.send('Hello from Firebase!');
// });

exports.newTask = functions.firestore
    .document('tasks/{taskId}')
    .onCreate(async (snap, context) => {
        const newTask = snap.data();
        const userId = newTask.ministry.id;

        const userData = await admin
            .firestore()
            .collection('users')
            .doc(userId)
            .get();

        const user = userData.data();
        const tokens = user.tokens || [];

        const notification = {
            notification: {
                title: 'Uma nova escala pra você!',
                body: `No dia ${moment(newTask.date).format('DD/MM/YY')} você tem ${newTask.functions.length > 1 ? 'as funções' : 'a função'}: ${newTask.functions.join(', ')}.`
            }
        }

        const notificationResult = await admin
            .messaging()
            .sendToDevice(tokens, notification)

        notificationResult.results.forEach(r => {
            if (r.error) {
                functions.logger.error(`An ocurred error. taskId: ${snap.id}`, r.error.message)
            }
        })
    });

exports.updateUser = functions.firestore
    .document('users/{userId}')
    .onUpdate(async (change, context) => {
        const id = change.after.id
        const previousValue = change.before.data()
        const newValue = change.after.data()

        for await (const minister of newValue.ministers) {
            const previousMinisters = previousValue.ministers.map(m => m.id)
            if (!previousMinisters.includes(minister.id)) {
                admin
                    .firestore()
                    .collection('ministers')
                    .doc(minister.id)
                    .get()
                    .then(data => {
                        let m = data.data()
                        if (m.users) {
                            m.users.push(id)
                        } else {
                            m.users = [id]
                        }

                        admin
                            .firestore()
                            .collection(ministers)
                            .doc(minister.id)
                            .set({ users: m.users })
                            .catch(error => {
                                functions.logger.error(`An ocorred error while update minister: ${minister.id}`, error)
                            })
                    })
                    .catch(error => {
                        functions.logger.error(`An ocorred error while find minister: ${minister.id}`, error)
                    })
            }
        }


    })