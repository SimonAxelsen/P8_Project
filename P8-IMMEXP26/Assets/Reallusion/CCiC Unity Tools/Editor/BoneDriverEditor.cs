/* 
 * Copyright (C) 2021 Victor Soupday
 * This file is part of CC_Unity_Tools <https://github.com/soupday/CC_Unity_Tools>
 * 
 * CC_Unity_Tools is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * CC_Unity_Tools is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with CC_Unity_Tools.  If not, see <https://www.gnu.org/licenses/>.
 */

using UnityEngine;
using UnityEditor;

namespace Reallusion.Runtime
{
    [CustomEditor(typeof(BoneDriver))]
    public class BoneDriverEditor : Editor
    {
        private BoneDriver boneDriver;

        const float LABEL_WIDTH = 80f;
        const float SPACER = 20f;
        const float LINE_SPACER = 5f;
        const float BUTTON_WIDTH = 190f;

        private void OnEnable()
        {
            boneDriver = (BoneDriver)target;
        }

        public override void OnInspectorGUI()
        {
            //base.OnInspectorGUI();

            OnBoneDriverGUI();
        }

        private Styles textStyle;

        public class Styles
        {
            public GUIStyle titleStyle;
            public GUIStyle toggleStyle;
            public GUIStyle labelStyle;
            public GUIStyle helpStyle;

            public Styles()
            {
                titleStyle = new GUIStyle(GUI.skin.label);
                titleStyle.fontSize = 16;
                titleStyle.fontStyle = FontStyle.BoldAndItalic;

                toggleStyle = new GUIStyle(GUI.skin.toggle);
                toggleStyle.fontSize = 12;

                labelStyle = new GUIStyle(GUI.skin.label);
                labelStyle.fontSize = 12;

                helpStyle = new GUIStyle(GUI.skin.GetStyle("HelpBox"));
                helpStyle.fontSize = 12;
            }
        }

        private void OnBoneDriverGUI()
        {
            if (textStyle == null) textStyle = new Styles();

            GUILayout.BeginVertical();

            //Expression Driver
            GUILayout.Label("Expression Driver", textStyle.titleStyle);
            GUILayout.Space(LINE_SPACER);
            EditorGUILayout.HelpBox("The expression can be used to drive the face bones directly (instead of with an animation track)", MessageType.Info, true);
            boneDriver.bones = GUILayout.Toggle(boneDriver.bones, "Expressions Drive Face Bones", textStyle.toggleStyle);
            GUILayout.Space(LINE_SPACER);
            EditorGUILayout.HelpBox("The expression can be copied in real time to any objects with the same blendshapes instead of needing to have animation tracks for each blendshape on each object.", MessageType.Info, true);
            boneDriver.expressions = GUILayout.Toggle(boneDriver.expressions, "Expressions are copied to all face parts", textStyle.toggleStyle);
            GUILayout.Space(LINE_SPACER);
            EditorGUILayout.HelpBox("The expression can be used to drive constraint blend shapes (those beginning with 'C_' in CC5 characters).", MessageType.Info, true);
            boneDriver.constraint = GUILayout.Toggle(boneDriver.constraint, "Expressions control constraint blend shapes.", textStyle.toggleStyle);
            GUILayout.Space(SPACER);

            // Viseme Amplification
            GUILayout.Label("Viseme Amplification", textStyle.titleStyle);
            GUILayout.Space(LINE_SPACER);
            EditorGUILayout.HelpBox("Expression Visemes can be amplified in real time by adjusting the power slider (lower will have more effect) and scale slider (a direct multiply of the power adjusted viseme value)", MessageType.Info, true);
            string ampTip = "(Viseme Value ^ Power) * Scale";
            boneDriver.amplify = GUILayout.Toggle(boneDriver.amplify, new GUIContent("Amplify Vismes", ampTip), textStyle.toggleStyle);
            GUILayout.Space(LINE_SPACER);
            EditorGUI.BeginDisabledGroup(!boneDriver.amplify);
            GUILayout.BeginHorizontal();
            GUILayout.Space(SPACER);
            GUILayout.Label(new GUIContent("Power", ampTip), textStyle.labelStyle, GUILayout.Width(LABEL_WIDTH));
            boneDriver.visemePower = EditorGUILayout.Slider(boneDriver.visemePower, 0.1f, 2.0f);
            GUILayout.EndHorizontal();
            GUILayout.BeginHorizontal();
            GUILayout.Space(SPACER);
            GUILayout.Label(new GUIContent("Scale", ampTip), textStyle.labelStyle, GUILayout.Width(LABEL_WIDTH));
            boneDriver.visemeScale = EditorGUILayout.Slider(boneDriver.visemeScale, 0f, 2f);
            GUILayout.EndHorizontal();
            EditorGUI.EndDisabledGroup();
            GUILayout.Space(SPACER);

            // Rebuild
            GUILayout.Label("Rebuild & Reset the BoneDriver", textStyle.titleStyle);
            GUILayout.Space(LINE_SPACER);
            EditorGUILayout.HelpBox("Rebuild the data needed for the BoneDriver in case of any problems. This will reset the BoneDriver to its original settings", MessageType.Info, true);
            if (GUILayout.Button("Rebuild Bone Driver"))
            {
                boneDriver.RebuildSetup();
            }

            GUILayout.EndVertical();
        }
    }
}
